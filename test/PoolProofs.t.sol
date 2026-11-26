// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixture} from "./Fixture.sol";
import {Pool} from "../src/Pool.sol";
import {FixtureData} from "./FixtureData.sol";

/// @dev The pool with the real verifier and real Groth16 proofs, generated off-chain from the
///      proving key for exactly this pool address and chain id.
contract PoolProofsTest is Fixture {
    function test_FreshPoolMatchesTheProver() public {
        System memory sys = _deployReal(1000);
        assertEq(address(sys.pool), FixtureData.POOL);
        assertEq(sys.pool.lastRoot(), FixtureData.EMPTY_ROOT);
        assertTrue(sys.pool.isKnownRoot(FixtureData.EMPTY_ROOT));
        assertEq(address(sys.pool.verifier()), address(sys.verifier));
        assertEq(address(sys.pool.hasher()), address(sys.hasher));
        assertEq(block.chainid, FixtureData.CHAIN_ID);
    }

    /// Six real transactions. After each one the pool's root equals the prover's.
    function test_MainStoryline() public {
        System memory sys = _deployReal(1000);
        uint256 paidBefore = WITHDRAW_TO.balance;
        _play(sys, "a_withdraw");
        // In: 0.1 + 0.05. Out: 0.05 + 0.079 and a 0.001 fee. What remains is Bob's 0.02.
        assertEq(sys.pool.totalHeld(), 0.02 ether);
        assertEq(address(sys.pool).balance, 0.02 ether);
        assertEq(WITHDRAW_TO.balance - paidBefore, 0.129 ether);
        assertEq(sys.pool.nextIndex(), 12);
        assertEq(sys.pool.currentRootIndex(), 6);
        assertEq(sys.pool.lastRoot(), _rootAfter("a_withdraw"));
        for (uint256 i = 0; i < MAIN_STORYLINE.length; i++) {
            Pool.Proof memory p = _proof(MAIN_STORYLINE[i]);
            assertTrue(sys.pool.nullifierSpent(p.nullifiers[0]));
            assertTrue(sys.pool.nullifierSpent(p.nullifiers[1]));
        }
        // Bob's remaining note can still leave.
        assertTrue(_try(sys, "h_spend_under_root3", ALICE) == false, "unrelated proof must not pass");
    }

    /// The 16 public signals the pool assembles are exactly those the prover used.
    function test_PoolAssemblesTheSignalsTheProverUsed() public {
        System memory sys = _deployReal(1000);
        string[8] memory names = ["a_deposit_1", "a_deposit_2", "a_pay_bob", "b_withdraw", "a_merge", "a_withdraw", "h_deposit_1", "h_spend_under_root3"];
        for (uint256 i = 0; i < names.length; i++) {
            Pool.Proof memory p = _proof(names[i]);
            uint256[16] memory got = sys.pool.publicSignals(p, _ext(names[i]));
            uint256[16] memory expected = _signals(names[i]);
            for (uint256 j = 0; j < 16; j++) assertEq(got[j], expected[j], string.concat(names[i], " signal ", vm.toString(j)));
        }
    }

    function test_EventsOfADeposit() public {
        System memory sys = _deployReal(1000);
        Pool.Proof memory p = _proof("a_deposit_1");
        Pool.ExtData memory e = _ext("a_deposit_1");
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewNullifier(p.nullifiers[0]);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewNullifier(p.nullifiers[1]);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.Deposit(ALICE, 0.1 ether);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewCommitment(p.commitments[0], 0, e.note0);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewCommitment(p.commitments[1], 1, e.note1);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.AuditRecord(p.nullifiers[0], p.auditEphemeral, p.auditCipher, [FixtureData.AUDITOR_X, FixtureData.AUDITOR_Y]);
        assertTrue(_try(sys, "a_deposit_1", ALICE));
    }

    /// A relayed transfer publishes the encrypted notes and pays the relayer named in the proof.
    function test_RelayedTransfer() public {
        System memory sys = _deployReal(1000);
        _play(sys, "a_deposit_2");
        uint256 relayerBefore = RELAYER.balance;
        Pool.Proof memory p = _proof("a_pay_bob");
        Pool.ExtData memory e = _ext("a_pay_bob");
        assertEq(e.note0, hex"1111");
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewCommitment(p.commitments[0], 4, hex"1111");
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewCommitment(p.commitments[1], 5, hex"2222");
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.RelayerPaid(RELAYER, 0.001 ether);
        assertTrue(_try(sys, "a_pay_bob", RELAYER));
        // The relayer is richer by the fee and poorer by its own gas; the pool keeps the rest.
        assertEq(address(sys.pool).balance, 0.149 ether);
        assertEq(sys.pool.totalHeld(), 0.149 ether);
        assertGt(RELAYER.balance, relayerBefore - 0.01 ether);
    }

    /// Whoever submits the transaction, the fee goes to the relayer written into the proof.
    function test_SubmittedBySomeoneElse() public {
        System memory sys = _deployReal(1000);
        _play(sys, "a_deposit_2");
        uint256 relayerBefore = RELAYER.balance;
        assertTrue(_try(sys, "a_pay_bob", ALICE));
        assertEq(RELAYER.balance, relayerBefore + 0.001 ether);
    }

    function test_ReplayIsRefused() public {
        System memory sys = _deployReal(1000);
        _play(sys, "b_withdraw");
        _refused(sys, "b_withdraw", BOB, Pool.NullifierUsed.selector);
        _refused(sys, "a_pay_bob", RELAYER, Pool.NullifierUsed.selector);
        assertEq(sys.pool.nextIndex(), 8);
        assertEq(WITHDRAW_TO.balance, 0.05 ether);
    }

    /// Another proof for the same note, made under another root, spends the same nullifier.
    function test_ANewProofForASpentNoteIsRefused() public {
        System memory sys = _deployReal(1000);
        _playHistory(sys);
        assertTrue(_try(sys, "h_spend_under_root1", ALICE));
        _refused(sys, "h_spend_under_root2", ALICE, Pool.NullifierUsed.selector);
        _refused(sys, "h_spend_under_root3", ALICE, Pool.NullifierUsed.selector);
    }

    function test_UnknownRootIsRefused() public {
        System memory sys = _deployReal(1000);
        Pool.Proof memory p = _proof("a_deposit_1");
        p.root = uint256(keccak256("a root that never existed"));
        Pool.ExtData memory e = _ext("a_deposit_1");
        vm.expectRevert(Pool.UnknownRoot.selector);
        _tryWith(sys.pool, p, e, 0.1 ether, ALICE);
    }

    function test_RelayerCannotChangeTheTransaction() public {
        System memory sys = _deployReal(1000);
        _play(sys, "a_deposit_2");
        Pool.Proof memory p = _proof("a_pay_bob");
        Pool.ExtData memory e = _ext("a_pay_bob");
        bytes4 invalid = Pool.InvalidProof.selector;

        Pool.ExtData memory t = e;
        t.recipient = WITHDRAW_TO;
        vm.expectRevert(invalid);
        _tryWith(sys.pool, p, t, 0, RELAYER);
        t = e;
        t.extAmount = -1;
        t.recipient = WITHDRAW_TO;
        vm.expectRevert(invalid);
        _tryWith(sys.pool, p, t, 0, RELAYER);
        t = e;
        t.fee = e.fee + 1;
        vm.expectRevert(invalid);
        _tryWith(sys.pool, p, t, 0, RELAYER);
        t = e;
        t.relayer = ALICE;
        vm.expectRevert(invalid);
        _tryWith(sys.pool, p, t, 0, RELAYER);
        t = e;
        t.note0 = hex"ab";
        vm.expectRevert(invalid);
        _tryWith(sys.pool, p, t, 0, RELAYER);
        t = e;
        t.note1 = hex"";
        vm.expectRevert(invalid);
        _tryWith(sys.pool, p, t, 0, RELAYER);

        // The public signals that come from calldata are bound as well.
        Pool.Proof memory q = p;
        q.nullifiers[0] = addmod(q.nullifiers[0], 1, FIELD);
        vm.expectRevert(invalid);
        _tryWith(sys.pool, q, e, 0, RELAYER);
        q = p;
        q.commitments[1] = q.commitments[0];
        vm.expectRevert(invalid);
        _tryWith(sys.pool, q, e, 0, RELAYER);
        q = p;
        q.auditCipher[3] = addmod(q.auditCipher[3], 1, FIELD);
        vm.expectRevert(invalid);
        _tryWith(sys.pool, q, e, 0, RELAYER);
        q = p;
        q.auditEphemeral[0] = addmod(q.auditEphemeral[0], 1, FIELD);
        vm.expectRevert(invalid);
        _tryWith(sys.pool, q, e, 0, RELAYER);

        assertEq(sys.pool.nextIndex(), 4);
        // Untouched, it goes through.
        assertTrue(_try(sys, "a_pay_bob", RELAYER));
    }

    function test_PublicSignalsOutsideTheFieldAreRefusedBeforeTheProof() public {
        System memory sys = _deployReal(1000);
        Pool.Proof memory p = _proof("a_deposit_1");
        Pool.ExtData memory e = _ext("a_deposit_1");
        p.nullifiers[1] = FIELD;
        vm.expectRevert(Pool.SignalOutOfRange.selector);
        _tryWith(sys.pool, p, e, 0.1 ether, ALICE);
        p = _proof("a_deposit_1");
        p.auditCipher[0] = FIELD;
        vm.expectRevert(Pool.SignalOutOfRange.selector);
        _tryWith(sys.pool, p, e, 0.1 ether, ALICE);
        // Nothing was marked as spent by the refused attempts.
        assertTrue(_try(sys, "a_deposit_1", ALICE));
    }

    function test_DepositNeedsTheRightValue() public {
        System memory sys = _deployReal(1000);
        Pool.Proof memory p = _proof("a_deposit_1");
        Pool.ExtData memory e = _ext("a_deposit_1");
        vm.expectRevert(Pool.WrongValue.selector);
        _tryWith(sys.pool, p, e, 0.1 ether - 1, ALICE);
        vm.expectRevert(Pool.WrongValue.selector);
        _tryWith(sys.pool, p, e, 0, ALICE);
        // A transfer with value is refused too.
        _play(sys, "a_deposit_1");
        p = _proof("a_pay_bob");
        e = _ext("a_pay_bob");
        vm.expectRevert(Pool.WrongValue.selector);
        _tryWith(sys.pool, p, e, 1, RELAYER);
    }

    function test_DepositLimitsWithRealProofs() public {
        System memory sys = _deployReal(1000);
        vm.prank(OWNER);
        sys.pool.setLimits(0.09 ether, POOL_CAP);
        _refused(sys, "a_deposit_1", ALICE, Pool.DepositTooLarge.selector);
        assertEq(sys.pool.nextIndex(), 0);

        vm.prank(OWNER);
        sys.pool.setLimits(MAX_DEPOSIT, 0.12 ether);
        assertTrue(_try(sys, "a_deposit_1", ALICE));
        _refused(sys, "a_deposit_2", ALICE, Pool.PoolCapReached.selector);
        assertEq(sys.pool.nextIndex(), 2);
        assertEq(sys.pool.totalHeld(), 0.1 ether);

        // Raising the cap lets the next deposit through; the refused one left no trace.
        vm.prank(OWNER);
        sys.pool.setLimits(MAX_DEPOSIT, POOL_CAP);
        assertTrue(_try(sys, "a_deposit_2", ALICE));
        assertEq(sys.pool.totalHeld(), 0.15 ether);
    }

    function test_PauseStopsDepositsOnlyWithRealProofs() public {
        System memory sys = _deployReal(1000);
        vm.prank(OWNER);
        sys.pool.setDepositsPaused(true);
        _refused(sys, "a_deposit_1", ALICE, Pool.DepositsArePaused.selector);
        assertEq(sys.pool.nextIndex(), 0);

        vm.prank(OWNER);
        sys.pool.setDepositsPaused(false);
        _play(sys, "a_deposit_2");

        // Sending and withdrawing keep working while deposits are paused.
        vm.prank(OWNER);
        sys.pool.setDepositsPaused(true);
        assertTrue(_try(sys, "a_pay_bob", RELAYER));
        assertTrue(_try(sys, "b_withdraw", BOB));
        assertEq(WITHDRAW_TO.balance, 0.05 ether);
        assertEq(sys.pool.totalHeld(), 0.099 ether);
    }

    function test_ProofForAnotherPoolOrChainIsRefused() public {
        System memory sys = _deployReal(1000);
        _refused(sys, "a_deposit_1_other_pool", ALICE, Pool.InvalidProof.selector);
        _play(sys, "b_withdraw");
        _refused(sys, "a_merge_other_chain", ALICE, Pool.InvalidProof.selector);
    }

    function test_AuditorRotation() public {
        System memory sys = _deployReal(1000);
        _play(sys, "b_withdraw");

        vm.prank(OWNER);
        sys.pool.proposeAuditor(FixtureData.NEXT_AUDITOR_X, FixtureData.NEXT_AUDITOR_Y);
        // A proposal changes nothing: the old key stays in force until it is activated.
        _refused(sys, "a_merge_next_auditor", ALICE, Pool.InvalidProof.selector);
        vm.expectRevert(Pool.TooEarly.selector);
        sys.pool.activateAuditor();

        vm.warp(block.timestamp + 7 days);
        vm.prank(ALICE);
        sys.pool.activateAuditor();

        // Proofs sealed to the old key are now worthless; those sealed to the new one work.
        _refused(sys, "a_merge", ALICE, Pool.InvalidProof.selector);
        Pool.Proof memory p = _proof("a_merge_next_auditor");
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.AuditRecord(p.nullifiers[0], p.auditEphemeral, p.auditCipher, [FixtureData.NEXT_AUDITOR_X, FixtureData.NEXT_AUDITOR_Y]);
        // The pool now assembles the signals of a proof sealed to the new key exactly as the prover did.
        uint256[16] memory assembled = sys.pool.publicSignals(_proof("a_merge_next_auditor"), _ext("a_merge_next_auditor"));
        uint256[16] memory expected = _signals("a_merge_next_auditor");
        for (uint256 j = 0; j < 16; j++) assertEq(assembled[j], expected[j]);
        assertTrue(_try(sys, "a_merge_next_auditor", ALICE));
        assertEq(sys.pool.nextIndex(), 10);
        assertEq(sys.pool.totalHeld(), 0.099 ether);
    }

    /// The same three proofs are true statements about roots 1, 2 and 3. Whether the pool takes
    /// them depends only on which roots its history still knows. Each history size gets its own
    /// test, because a test cannot wind the deployer's nonce back to deploy a second pool on the
    /// address the proofs are made for.
    function test_HistoryOfTwoRootsForgetsTheOldest() public {
        System memory sys = _deployReal(2);
        _playHistory(sys);
        assertEq(sys.pool.lastRoot(), FixtureData.HISTORY_ROOT3);
        assertFalse(sys.pool.isKnownRoot(FixtureData.HISTORY_ROOT1));
        assertTrue(sys.pool.isKnownRoot(FixtureData.HISTORY_ROOT2));
        _refused(sys, "h_spend_under_root1", ALICE, Pool.UnknownRoot.selector);
        assertTrue(_try(sys, "h_spend_under_root2", ALICE));
        assertEq(sys.pool.totalHeld(), 0.03 ether);
    }

    function test_HistoryOfThreeRootsKeepsThemAll() public {
        System memory sys = _deployReal(3);
        _playHistory(sys);
        assertTrue(sys.pool.isKnownRoot(FixtureData.HISTORY_ROOT1));
        assertTrue(_try(sys, "h_spend_under_root1", ALICE));
        assertEq(sys.pool.totalHeld(), 0.03 ether);
    }

    function test_LongHistoryAlsoKeepsTheEmptyRoot() public {
        System memory sys = _deployReal(1000);
        _playHistory(sys);
        assertTrue(sys.pool.isKnownRoot(FixtureData.EMPTY_ROOT));
        assertTrue(sys.pool.isKnownRoot(FixtureData.HISTORY_ROOT1));
        assertTrue(_try(sys, "h_spend_under_root3", ALICE));
        assertEq(sys.pool.totalHeld(), 0.03 ether);
    }

    /// A proof with altered curve points makes the pairing check consume all the gas it is
    /// given. A caller that sets a gas limit loses that gas and nothing happens.
    function test_AlteredProofPointsFailWithinABoundedGasBudget() public {
        System memory sys = _deployReal(1000);
        Pool.Proof memory p = _proof("a_deposit_1");
        p.c[0] = addmod(p.c[0], 1, FIELD);
        vm.prank(ALICE);
        (bool ok,) = address(sys.pool).call{value: 0.1 ether, gas: 6_000_000}(abi.encodeCall(Pool.transact, (p, _ext("a_deposit_1"))));
        assertFalse(ok);
        assertEq(sys.pool.nextIndex(), 0);
        assertEq(sys.pool.totalHeld(), 0);
        assertEq(address(sys.pool).balance, 0);
    }

    function test_GasPerAction() public {
        System memory sys = _deployReal(1000);
        uint256 before = gasleft();
        assertTrue(_try(sys, "a_deposit_1", ALICE));
        emit log_named_uint("gas deposit", before - gasleft());
        before = gasleft();
        assertTrue(_try(sys, "a_deposit_2", ALICE));
        emit log_named_uint("gas second deposit", before - gasleft());
        before = gasleft();
        assertTrue(_try(sys, "a_pay_bob", RELAYER));
        emit log_named_uint("gas transfer with relayer fee", before - gasleft());
        before = gasleft();
        assertTrue(_try(sys, "b_withdraw", BOB));
        emit log_named_uint("gas withdraw", before - gasleft());
        before = gasleft();
        assertTrue(_try(sys, "a_merge", ALICE));
        emit log_named_uint("gas merge two notes", before - gasleft());
        before = gasleft();
        assertTrue(_try(sys, "a_withdraw", ALICE));
        emit log_named_uint("gas withdraw everything", before - gasleft());
    }
}
