// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixture} from "./Fixture.sol";
import {Pool, IHasher, IVerifier} from "../src/Pool.sol";
import {Hasher} from "../src/Hasher.sol";
import {Groth16Verifier} from "../src/Verifier.sol";
import {Registry} from "../src/Registry.sol";
import {Curve} from "../src/Curve.sol";
import {FixtureData} from "./FixtureData.sol";
import {AcceptAllVerifier, BadHasher, Reenter, Refuser, ForceSend} from "./mocks/TestHelpers.sol";

/// @dev Rules of the pool that need no real proof. The verifier accepts everything here, so
///      each test states exactly which check the pool itself is responsible for.
contract PoolTest is Fixture {
    event Transfer(address indexed from, address indexed to, uint256 value);

    // ------------------------------------------------------------------ construction

    function test_ConstructorStoresTheConfiguration() public {
        System memory sys = _deployReal(1000);
        Pool pool = sys.pool;
        assertEq(address(pool.verifier()), address(sys.verifier));
        assertEq(address(pool.hasher()), address(sys.hasher));
        assertEq(pool.levels(), 24);
        assertEq(pool.rootHistorySize(), 1000);
        assertEq(pool.owner(), OWNER);
        assertEq(pool.pendingOwner(), address(0));
        assertEq(pool.maxDeposit(), MAX_DEPOSIT);
        assertEq(pool.poolCap(), POOL_CAP);
        assertEq(pool.totalHeld(), 0);
        assertFalse(pool.depositsPaused());
        assertEq(pool.pendingAuditorEta(), 0);
        assertEq(pool.nextIndex(), 0);
        assertEq(pool.currentRootIndex(), 0);
        assertEq(pool.lastRoot(), FixtureData.EMPTY_ROOT);
        assertTrue(pool.isKnownRoot(FixtureData.EMPTY_ROOT));
        assertFalse(pool.isKnownRoot(0));
        assertFalse(pool.isKnownRoot(1));
        uint256[2] memory key = pool.auditorKey();
        assertEq(key[0], FixtureData.AUDITOR_X);
        assertEq(key[1], FixtureData.AUDITOR_Y);
        assertEq(uint256(pool.pendingAuditorKey()[0]), 0);
    }

    function test_ConstructorRefusesBadArguments() public {
        Hasher hasher = new Hasher();
        AcceptAllVerifier verifier = new AcceptAllVerifier();
        uint256[2] memory key = [FixtureData.AUDITOR_X, FixtureData.AUDITOR_Y];
        vm.expectRevert(Pool.BadConfig.selector);
        new Pool(IVerifier(address(0)), IHasher(address(hasher)), 24, 1000, key, MAX_DEPOSIT, POOL_CAP, OWNER);
        vm.expectRevert(Pool.BadConfig.selector);
        new Pool(IVerifier(address(verifier)), IHasher(address(0)), 24, 1000, key, MAX_DEPOSIT, POOL_CAP, OWNER);
        vm.expectRevert(Pool.BadConfig.selector);
        new Pool(IVerifier(address(verifier)), IHasher(address(hasher)), 0, 1000, key, MAX_DEPOSIT, POOL_CAP, OWNER);
        vm.expectRevert(Pool.BadConfig.selector);
        new Pool(IVerifier(address(verifier)), IHasher(address(hasher)), 32, 1000, key, MAX_DEPOSIT, POOL_CAP, OWNER);
        vm.expectRevert(Pool.BadConfig.selector);
        new Pool(IVerifier(address(verifier)), IHasher(address(hasher)), 24, 0, key, MAX_DEPOSIT, POOL_CAP, OWNER);
        vm.expectRevert(Pool.BadConfig.selector);
        new Pool(IVerifier(address(verifier)), IHasher(address(hasher)), 24, 1000, key, MAX_DEPOSIT, POOL_CAP, address(0));
    }

    /// A hasher that is not the circuit's Poseidon can never be deployed with.
    function test_ConstructorRefusesAWrongHasher() public {
        IVerifier verifier = IVerifier(address(new AcceptAllVerifier()));
        IHasher bad = IHasher(address(new BadHasher()));
        vm.expectRevert(Pool.BadHasher.selector);
        new Pool(verifier, bad, 24, 1000, [FixtureData.AUDITOR_X, FixtureData.AUDITOR_Y], MAX_DEPOSIT, POOL_CAP, OWNER);
    }

    function test_ConstructorRefusesInvalidAuditorKeys(uint256 i) public {
        i = bound(i, 0, FixtureData.INVALID_KEY_COUNT - 1);
        uint256[2][12] memory invalid = FixtureData.invalidKeys();
        IVerifier verifier = IVerifier(address(new AcceptAllVerifier()));
        IHasher hasher = IHasher(address(new Hasher()));
        vm.expectRevert(Pool.BadAuditorKey.selector);
        new Pool(verifier, hasher, 24, 1000, invalid[i], MAX_DEPOSIT, POOL_CAP, OWNER);
    }

    // ------------------------------------------------------------------ commitment tree

    /// Ten commitments recorded from a pool that ran this protocol, replayed through this pool's
    /// tree, must give the root that pool published.
    function test_TreeMatchesTheKnownAnswerVectors() public {
        System memory sys = _deployOpen(24, 1000);
        assertEq(sys.pool.lastRoot(), FixtureData.EMPTY_ROOT);
        uint256[10] memory leaves = FixtureData.treeVectorLeaves();
        for (uint256 i = 0; i < 5; i++) {
            Pool.Proof memory p = _blank(sys.pool.lastRoot(), _fresh(), _fresh());
            p.commitments = [leaves[2 * i], leaves[2 * i + 1]];
            sys.pool.transact(p, _emptyExt());
        }
        assertEq(sys.pool.lastRoot(), FixtureData.TREE_VECTOR_LAST_ROOT);
        assertEq(sys.pool.nextIndex(), 10);
    }

    function test_RootHistoryKeepsOnlyTheLastN() public {
        System memory sys = _deployOpen(4, 3);
        uint256 r0 = sys.pool.lastRoot();
        _openTransfer(sys.pool);
        uint256 r1 = sys.pool.lastRoot();
        _openTransfer(sys.pool);
        uint256 r2 = sys.pool.lastRoot();
        assertTrue(sys.pool.isKnownRoot(r0) && sys.pool.isKnownRoot(r1) && sys.pool.isKnownRoot(r2));
        // The fourth root replaces the first one in the ring.
        _openTransfer(sys.pool);
        uint256 r3 = sys.pool.lastRoot();
        assertFalse(sys.pool.isKnownRoot(r0), "evicted");
        assertTrue(sys.pool.isKnownRoot(r1) && sys.pool.isKnownRoot(r2) && sys.pool.isKnownRoot(r3));
        _openTransfer(sys.pool);
        uint256 r4 = sys.pool.lastRoot();
        assertFalse(sys.pool.isKnownRoot(r1), "evicted");
        assertTrue(sys.pool.isKnownRoot(r2) && sys.pool.isKnownRoot(r3) && sys.pool.isKnownRoot(r4));
        assertEq(sys.pool.currentRootIndex(), 1);
        assertEq(sys.pool.rootAt(0), r3);
        assertEq(sys.pool.rootAt(1), r4);
        assertEq(sys.pool.rootAt(2), r2);

        // A long history keeps everything, and the empty root stays valid.
        System memory long = _deployOpen(6, 1000);
        uint256 e0 = long.pool.lastRoot();
        for (uint256 i = 0; i < 20; i++) _openTransfer(long.pool);
        assertTrue(long.pool.isKnownRoot(e0));
        assertEq(long.pool.currentRootIndex(), 20);
    }

    function test_ProofOnAnEvictedRootIsRefused() public {
        System memory sys = _deployOpen(4, 2);
        uint256 empty = sys.pool.lastRoot();
        _openTransfer(sys.pool);
        _openTransfer(sys.pool);
        assertFalse(sys.pool.isKnownRoot(empty));
        vm.expectRevert(Pool.UnknownRoot.selector);
        sys.pool.transact(_blank(empty, _fresh(), _fresh()), _emptyExt());
    }

    function test_TreeFull() public {
        System memory sys = _deployOpen(1, 10);
        _openTransfer(sys.pool);
        assertEq(sys.pool.nextIndex(), 2);
        Pool.Proof memory p = _proofFor(sys.pool);
        vm.expectRevert(Pool.TreeFull.selector);
        sys.pool.transact(p, _emptyExt());
    }

    // ------------------------------------------------------------------ inputs

    function test_ANullifierIsSpentOnce() public {
        System memory sys = _deployOpen(4, 10);
        uint256 n0 = _fresh();
        uint256 n1 = _fresh();
        sys.pool.transact(_blank(sys.pool.lastRoot(), n0, n1), _emptyExt());
        assertTrue(sys.pool.nullifierSpent(n0));
        assertTrue(sys.pool.nullifierSpent(n1));
        uint256 root = sys.pool.lastRoot();
        Pool.Proof memory again = _blank(root, n0, _fresh());
        vm.expectRevert(Pool.NullifierUsed.selector);
        sys.pool.transact(again, _emptyExt());
        again = _blank(root, _fresh(), n1);
        vm.expectRevert(Pool.NullifierUsed.selector);
        sys.pool.transact(again, _emptyExt());
        // A refused transaction leaves nothing behind.
        assertEq(sys.pool.nextIndex(), 2);
    }

    function test_RepeatedNullifierInsideOneTransaction() public {
        System memory sys = _deployOpen(4, 10);
        uint256 n = _fresh();
        Pool.Proof memory p = _blank(sys.pool.lastRoot(), n, n);
        vm.expectRevert(Pool.NullifierUsed.selector);
        sys.pool.transact(p, _emptyExt());
        // The first one was marked, but the revert undid it.
        assertFalse(sys.pool.nullifierSpent(n));
    }

    function test_PublicSignalsOutsideTheFieldAreRefused() public {
        System memory sys = _deployOpen(4, 10);
        uint256 root = sys.pool.lastRoot();
        Pool.Proof memory p = _blank(root, _fresh(), _fresh());
        Pool.Proof memory bad = p;
        bad.nullifiers[1] = FIELD;
        vm.expectRevert(Pool.SignalOutOfRange.selector);
        sys.pool.transact(bad, _emptyExt());
        bad = p;
        bad.commitments[0] = FIELD;
        vm.expectRevert(Pool.SignalOutOfRange.selector);
        sys.pool.transact(bad, _emptyExt());
        bad = p;
        bad.auditEphemeral[1] = FIELD;
        vm.expectRevert(Pool.SignalOutOfRange.selector);
        sys.pool.transact(bad, _emptyExt());
        bad = p;
        bad.auditCipher[4] = FIELD;
        vm.expectRevert(Pool.SignalOutOfRange.selector);
        sys.pool.transact(bad, _emptyExt());
        // One below the field is fine.
        bad = _blank(root, _fresh(), _fresh());
        bad.auditCipher[4] = FIELD - 1;
        sys.pool.transact(bad, _emptyExt());
        // The root is looked up before anything else.
        bad = _blank(FIELD, _fresh(), _fresh());
        vm.expectRevert(Pool.UnknownRoot.selector);
        sys.pool.transact(bad, _emptyExt());
    }

    function test_AmountsOutsideTheRangeAreRefused() public {
        System memory sys = _deployOpen(4, 10);
        vm.deal(address(this), 1 << 100);
        uint256 limit = sys.pool.AMOUNT_LIMIT();
        assertEq(limit, 1 << 96);

        uint256 root = sys.pool.lastRoot();
        Pool.ExtData memory e = _emptyExt();
        e.extAmount = int256(limit);
        vm.expectRevert(Pool.AmountOutOfRange.selector);
        sys.pool.transact{value: 1 << 96}(_blank(root, _fresh(), _fresh()), e);

        e = _emptyExt();
        e.extAmount = -int256(limit);
        e.recipient = ALICE;
        vm.expectRevert(Pool.AmountOutOfRange.selector);
        sys.pool.transact(_blank(root, _fresh(), _fresh()), e);

        e = _emptyExt();
        e.fee = limit;
        e.relayer = RELAYER;
        vm.expectRevert(Pool.AmountOutOfRange.selector);
        sys.pool.transact(_blank(root, _fresh(), _fresh()), e);
    }

    function test_PayeesAreChecked() public {
        System memory sys = _deployOpen(4, 10);
        _openDeposit(sys.pool, ALICE, 0.1 ether);
        uint256 root = sys.pool.lastRoot();

        Pool.ExtData memory e = _emptyExt();
        e.extAmount = -1;
        vm.expectRevert(Pool.NoRecipient.selector);
        sys.pool.transact(_blank(root, _fresh(), _fresh()), e);

        e.recipient = address(sys.pool);
        vm.expectRevert(Pool.BadPayee.selector);
        sys.pool.transact(_blank(root, _fresh(), _fresh()), e);

        e = _emptyExt();
        e.fee = 1;
        vm.expectRevert(Pool.NoRecipient.selector);
        sys.pool.transact(_blank(root, _fresh(), _fresh()), e);

        e.relayer = address(sys.pool);
        vm.expectRevert(Pool.BadPayee.selector);
        sys.pool.transact(_blank(root, _fresh(), _fresh()), e);

        // The payee is checked before any proof is looked at, and nothing was spent.
        assertEq(sys.pool.nextIndex(), 2);
        assertEq(sys.pool.totalHeld(), 0.1 ether);
    }

    // ------------------------------------------------------------------ deposits

    function test_DepositIsCountedAndEmits() public {
        System memory sys = _deployOpen(4, 10);
        Pool.Proof memory p = _proofFor(sys.pool);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewNullifier(p.nullifiers[0]);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewNullifier(p.nullifiers[1]);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.Deposit(ALICE, 0.1 ether);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewCommitment(p.commitments[0], 0, hex"00");
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.NewCommitment(p.commitments[1], 1, hex"00");
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.AuditRecord(p.nullifiers[0], p.auditEphemeral, p.auditCipher, [FixtureData.AUDITOR_X, FixtureData.AUDITOR_Y]);
        vm.prank(ALICE);
        sys.pool.transact{value: 0.1 ether}(p, _depositExt(0.1 ether));
        assertEq(sys.pool.totalHeld(), 0.1 ether);
        assertEq(address(sys.pool).balance, 0.1 ether);
        assertEq(sys.pool.nextIndex(), 2);
    }

    function test_DepositNeedsExactlyItsAmount() public {
        System memory sys = _deployOpen(4, 10);
        Pool.Proof memory p = _proofFor(sys.pool);
        Pool.ExtData memory e = _depositExt(0.1 ether);
        vm.prank(ALICE);
        vm.expectRevert(Pool.WrongValue.selector);
        sys.pool.transact{value: 0.1 ether - 1}(p, e);
        vm.prank(ALICE);
        vm.expectRevert(Pool.WrongValue.selector);
        sys.pool.transact{value: 0.1 ether + 1}(p, e);
        // A transfer carries no value.
        vm.prank(ALICE);
        vm.expectRevert(Pool.WrongValue.selector);
        sys.pool.transact{value: 1}(p, _emptyExt());
        assertEq(sys.pool.nextIndex(), 0);
        vm.prank(ALICE);
        sys.pool.transact{value: 0.1 ether}(p, e);
    }

    function test_DepositLimits() public {
        System memory sys = _deployOpen(4, 10);
        uint256 cap = sys.pool.totalHeld() + 0.05 ether;
        vm.prank(OWNER);
        sys.pool.setLimits(MAX_DEPOSIT, cap);

        Pool.Proof memory p = _proofFor(sys.pool);
        vm.prank(ALICE);
        vm.expectRevert(Pool.DepositTooLarge.selector);
        sys.pool.transact{value: MAX_DEPOSIT + 1}(p, _depositExt(MAX_DEPOSIT + 1));

        p = _proofFor(sys.pool);
        vm.prank(ALICE);
        vm.expectRevert(Pool.PoolCapReached.selector);
        sys.pool.transact{value: 0.06 ether}(p, _depositExt(0.06 ether));

        _openDeposit(sys.pool, ALICE, 0.05 ether);
        assertEq(sys.pool.totalHeld(), 0.05 ether);
        assertEq(sys.pool.maxDeposit(), MAX_DEPOSIT);
        assertEq(sys.pool.poolCap(), cap);
        // Money that left the notes frees room in the cap.
        _openWithdraw(sys.pool, WITHDRAW_TO, 0.05 ether, 0);
        assertEq(sys.pool.totalHeld(), 0);
        _openDeposit(sys.pool, ALICE, 0.05 ether);
        vm.prank(OWNER);
        sys.pool.setLimits(MAX_DEPOSIT, POOL_CAP);
        _openDeposit(sys.pool, ALICE, MAX_DEPOSIT);
        assertEq(sys.pool.totalHeld(), 0.15 ether);
    }

    function test_PausingStopsDepositsOnly() public {
        System memory sys = _deployOpen(4, 10);
        _openDeposit(sys.pool, ALICE, 0.1 ether);
        vm.prank(OWNER);
        vm.expectEmit(false, false, false, true, address(sys.pool));
        emit Pool.DepositsPaused(true);
        sys.pool.setDepositsPaused(true);
        assertTrue(sys.pool.depositsPaused());
        Pool.Proof memory p = _proofFor(sys.pool);
        vm.prank(ALICE);
        vm.expectRevert(Pool.DepositsArePaused.selector);
        sys.pool.transact{value: 0.01 ether}(p, _depositExt(0.01 ether));
        _openTransfer(sys.pool);
        _openWithdraw(sys.pool, WITHDRAW_TO, 0.05 ether, 0);
        assertEq(WITHDRAW_TO.balance, 0.05 ether);
        vm.prank(OWNER);
        sys.pool.setDepositsPaused(false);
        _openDeposit(sys.pool, ALICE, 0.01 ether);
    }

    // ------------------------------------------------------------------ withdrawals and held payments

    function test_WithdrawalPaysRecipientAndRelayer() public {
        System memory sys = _deployOpen(4, 10);
        _openDeposit(sys.pool, ALICE, 0.1 ether);
        uint256 relayerBefore = RELAYER.balance;
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.Withdrawal(WITHDRAW_TO, 0.05 ether);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.RelayerPaid(RELAYER, 0.001 ether);
        _openWithdraw(sys.pool, WITHDRAW_TO, 0.05 ether, 0.001 ether);
        assertEq(WITHDRAW_TO.balance, 0.05 ether);
        assertEq(RELAYER.balance, relayerBefore + 0.001 ether);
        assertEq(sys.pool.totalHeld(), 0.1 ether - 0.05 ether - 0.001 ether);
        assertEq(address(sys.pool).balance, sys.pool.totalHeld());
        assertEq(sys.pool.owed(WITHDRAW_TO), 0);
    }

    function test_APayeeThatRefusesGetsItsMoneyLater() public {
        System memory sys = _deployOpen(4, 10);
        Refuser refuser = new Refuser();
        _openDeposit(sys.pool, ALICE, 0.1 ether);

        // A withdrawal to a contract that refuses ETH, through a relayer that is paid all the same.
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.PaymentHeld(address(refuser), 0.03 ether);
        _openWithdraw(sys.pool, address(refuser), 0.03 ether, 0.001 ether);
        assertEq(address(refuser).balance, 0);
        assertEq(sys.pool.owed(address(refuser)), 0.03 ether);
        assertEq(sys.pool.totalHeld(), 0.1 ether - 0.03 ether - 0.001 ether);
        assertEq(address(sys.pool).balance, 0.1 ether - 0.001 ether);

        // Only the payee can collect, and only once it accepts.
        vm.expectRevert(Pool.NothingOwed.selector);
        sys.pool.claim();
        vm.prank(address(refuser));
        vm.expectRevert(Pool.TransferFailed.selector);
        sys.pool.claim();
        assertEq(sys.pool.owed(address(refuser)), 0.03 ether);
        refuser.setAccepting(true);
        vm.prank(address(refuser));
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.Claimed(address(refuser), 0.03 ether);
        sys.pool.claim();
        assertEq(address(refuser).balance, 0.03 ether);
        assertEq(sys.pool.owed(address(refuser)), 0);
        vm.prank(address(refuser));
        vm.expectRevert(Pool.NothingOwed.selector);
        sys.pool.claim();

        // A relayer that refuses is treated the same way, and held amounts add up.
        refuser.setAccepting(false);
        _openWithdrawVia(sys.pool, WITHDRAW_TO, address(refuser), 0, 0.002 ether);
        _openWithdrawVia(sys.pool, WITHDRAW_TO, address(refuser), 0, 0.003 ether);
        assertEq(sys.pool.owed(address(refuser)), 0.005 ether);
        refuser.setAccepting(true);
        refuser.collect(address(sys.pool));
        assertEq(address(refuser).balance, 0.035 ether);
        assertEq(address(sys.pool).balance, sys.pool.totalHeld());
    }

    function test_ReenteringIsRefusedAndEverythingIsPaidOnce() public {
        System memory sys = _deployOpen(4, 10);
        vm.prank(OWNER);
        sys.pool.setLimits(1 ether, 5 ether);
        _openDeposit(sys.pool, ALICE, 1 ether);
        Reenter thief = new Reenter();

        // A second withdrawal the thief will try to submit from inside its receive function.
        Pool.Proof memory inner = _blank(sys.pool.lastRoot(), _fresh(), _fresh());
        Pool.ExtData memory innerExt = _emptyExt();
        innerExt.recipient = address(thief);
        innerExt.extAmount = -int256(0.5 ether);
        thief.arm(address(sys.pool), abi.encodeCall(Pool.transact, (inner, innerExt)));

        // The payee gets 50,000 gas: not enough to get anywhere with the re-entry, so its
        // receive function runs out of gas and the payment is held instead.
        _openWithdraw(sys.pool, address(thief), 0.02 ether, 0);
        assertEq(thief.tried(), false);
        assertEq(address(thief).balance, 0);
        assertEq(sys.pool.owed(address(thief)), 0.02 ether);

        // claim() hands over all the gas left: now the re-entry really runs, and is locked out.
        thief.collect();
        assertEq(thief.tried(), true);
        assertFalse(thief.innerCallSucceeded());
        assertEq(address(thief).balance, 0.02 ether);
        assertEq(sys.pool.owed(address(thief)), 0);
        assertEq(address(sys.pool).balance, sys.pool.totalHeld());
        assertEq(sys.pool.totalHeld(), 1 ether - 0.02 ether);

        // Held again, with claim() armed as the inner call: a held payment cannot be collected twice.
        thief.arm(address(sys.pool), abi.encodeCall(Pool.claim, ()));
        _openWithdraw(sys.pool, address(thief), 0.01 ether, 0);
        // The small allowance is enough to try claim(), which the lock refuses. Whether the
        // 0.01 ETH was delivered at once or is held depends on the gas the attempt used up.
        assertEq(address(thief).balance + sys.pool.owed(address(thief)), 0.03 ether);
        if (sys.pool.owed(address(thief)) > 0) thief.collect();
        assertFalse(thief.innerCallSucceeded());
        assertEq(address(thief).balance, 0.03 ether);
        assertEq(sys.pool.owed(address(thief)), 0);
        assertEq(sys.pool.totalHeld(), 1 ether - 0.03 ether);
    }

    /// Even with a verifier that accepts anything, more than the pool holds cannot leave.
    function test_NothingBeyondTotalHeldCanLeave() public {
        System memory sys = _deployOpen(4, 10);
        _openDeposit(sys.pool, ALICE, 0.1 ether);
        Pool.Proof memory p = _blank(sys.pool.lastRoot(), _fresh(), _fresh());
        Pool.ExtData memory e = _emptyExt();
        e.recipient = WITHDRAW_TO;
        e.extAmount = -int256(0.1 ether + 1);
        // The books cannot go negative: the transaction fails, and nothing changed.
        (bool ok,) = address(sys.pool).call(abi.encodeCall(Pool.transact, (p, e)));
        assertFalse(ok);
        assertEq(sys.pool.totalHeld(), 0.1 ether);
        assertEq(WITHDRAW_TO.balance, 0);
        assertEq(sys.pool.nextIndex(), 2);
    }

    // ------------------------------------------------------------------ ETH sent by mistake

    function test_PlainEthIsRefusedAndForcedEthChangesNothing() public {
        System memory sys = _deployOpen(4, 10);
        _openDeposit(sys.pool, ALICE, 0.1 ether);
        (bool sent,) = address(sys.pool).call{value: 1 ether}("");
        assertFalse(sent);
        new ForceSend{value: 1 ether}(payable(address(sys.pool)));
        assertEq(address(sys.pool).balance, 1.1 ether);
        assertEq(sys.pool.totalHeld(), 0.1 ether);
        // The forced ETH cannot be withdrawn: the books decide what may leave.
        _openWithdraw(sys.pool, WITHDRAW_TO, 0.1 ether, 0);
        assertEq(WITHDRAW_TO.balance, 0.1 ether);
        assertEq(sys.pool.totalHeld(), 0);
    }

    // ------------------------------------------------------------------ owner

    function test_OwnerFunctionsRefuseEveryoneElse() public {
        System memory sys = _deployReal(10);
        vm.startPrank(ALICE);
        vm.expectRevert(Pool.NotOwner.selector);
        sys.pool.setDepositsPaused(true);
        vm.expectRevert(Pool.NotOwner.selector);
        sys.pool.setLimits(1, 1);
        vm.expectRevert(Pool.NotOwner.selector);
        sys.pool.proposeAuditor(FixtureData.NEXT_AUDITOR_X, FixtureData.NEXT_AUDITOR_Y);
        vm.expectRevert(Pool.NotOwner.selector);
        sys.pool.transferOwnership(ALICE);
        vm.expectRevert(Pool.NotOwner.selector);
        sys.pool.acceptOwnership();
        vm.stopPrank();
        // Anyone may finalise an auditor key change, but nobody may start one.
        vm.expectRevert(Pool.NothingPending.selector);
        sys.pool.activateAuditor();
    }

    function test_OwnershipMovesInTwoSteps() public {
        System memory sys = _deployReal(10);
        vm.prank(OWNER);
        vm.expectRevert(Pool.ZeroAddress.selector);
        sys.pool.transferOwnership(address(0));
        vm.prank(OWNER);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.OwnershipTransferStarted(OWNER, ALICE);
        sys.pool.transferOwnership(ALICE);
        assertEq(sys.pool.owner(), OWNER);
        assertEq(sys.pool.pendingOwner(), ALICE);
        // The old owner stays in charge until the new one accepts.
        vm.prank(OWNER);
        sys.pool.setDepositsPaused(true);
        vm.prank(ALICE);
        vm.expectEmit(true, true, true, true, address(sys.pool));
        emit Pool.OwnershipTransferred(OWNER, ALICE);
        sys.pool.acceptOwnership();
        assertEq(sys.pool.owner(), ALICE);
        assertEq(sys.pool.pendingOwner(), address(0));
        vm.prank(OWNER);
        vm.expectRevert(Pool.NotOwner.selector);
        sys.pool.setDepositsPaused(false);
        vm.prank(ALICE);
        sys.pool.setDepositsPaused(false);
    }

    function test_LimitsCanBeChanged() public {
        System memory sys = _deployReal(10);
        vm.prank(OWNER);
        vm.expectEmit(false, false, false, true, address(sys.pool));
        emit Pool.LimitsChanged(1 ether, 10 ether);
        sys.pool.setLimits(1 ether, 10 ether);
        assertEq(sys.pool.maxDeposit(), 1 ether);
        assertEq(sys.pool.poolCap(), 10 ether);
    }

    // ------------------------------------------------------------------ auditor key

    function test_AuditorKeyMustBeAValidPoint(uint256 i) public {
        System memory sys = _deployReal(10);
        i = bound(i, 0, FixtureData.INVALID_KEY_COUNT - 1);
        uint256[2][12] memory invalid = FixtureData.invalidKeys();
        vm.prank(OWNER);
        vm.expectRevert(Pool.BadAuditorKey.selector);
        sys.pool.proposeAuditor(invalid[i][0], invalid[i][1]);
        assertEq(sys.pool.pendingAuditorEta(), 0);
    }

    function test_AuditorKeyChangeWaitsSevenDays() public {
        System memory sys = _deployReal(10);
        uint256 start = block.timestamp;
        vm.prank(OWNER);
        vm.expectEmit(false, false, false, true, address(sys.pool));
        emit Pool.AuditorProposed(FixtureData.NEXT_AUDITOR_X, FixtureData.NEXT_AUDITOR_Y, start + 7 days);
        sys.pool.proposeAuditor(FixtureData.NEXT_AUDITOR_X, FixtureData.NEXT_AUDITOR_Y);
        assertEq(sys.pool.pendingAuditorEta(), start + 7 days);
        uint256[2] memory pending = sys.pool.pendingAuditorKey();
        assertEq(pending[0], FixtureData.NEXT_AUDITOR_X);
        // Still the old key.
        uint256[2] memory key = sys.pool.auditorKey();
        assertEq(key[0], FixtureData.AUDITOR_X);

        vm.warp(start + 7 days - 1);
        vm.expectRevert(Pool.TooEarly.selector);
        sys.pool.activateAuditor();

        vm.warp(start + 7 days);
        vm.prank(ALICE); // anyone may finalise
        vm.expectEmit(false, false, false, true, address(sys.pool));
        emit Pool.AuditorChanged(FixtureData.NEXT_AUDITOR_X, FixtureData.NEXT_AUDITOR_Y);
        sys.pool.activateAuditor();
        key = sys.pool.auditorKey();
        assertEq(key[0], FixtureData.NEXT_AUDITOR_X);
        assertEq(key[1], FixtureData.NEXT_AUDITOR_Y);
        assertEq(sys.pool.pendingAuditorEta(), 0);
        assertEq(uint256(sys.pool.pendingAuditorKey()[0]), 0);
        vm.expectRevert(Pool.NothingPending.selector);
        sys.pool.activateAuditor();

        // A later proposal overwrites the earlier one and restarts the clock.
        vm.prank(OWNER);
        sys.pool.proposeAuditor(FixtureData.AUDITOR_X, FixtureData.AUDITOR_Y);
        vm.prank(OWNER);
        sys.pool.proposeAuditor(FixtureData.NEXT_AUDITOR_X, FixtureData.NEXT_AUDITOR_Y);
        assertEq(sys.pool.pendingAuditorEta(), start + 14 days);
    }

    function test_EveryValidSubgroupPointIsAccepted(uint256 i) public view {
        i = bound(i, 0, FixtureData.VALID_KEY_COUNT - 1);
        uint256[2][5] memory valid = FixtureData.validKeys();
        assertTrue(Curve.isAuditorKey(valid[i][0], valid[i][1]));
    }

    // ------------------------------------------------------------------ view helpers

    function test_ExtDataHashBindsEverything() public {
        System memory sys = _deployReal(10);
        Pool.ExtData memory e = _ext("a_pay_bob");
        uint256 h = sys.pool.extDataHash(e);
        assertTrue(h < FIELD);
        Pool.ExtData memory changed = e;
        changed.recipient = ALICE;
        assertTrue(sys.pool.extDataHash(changed) != h, "recipient");
        changed = e;
        changed.extAmount = -1;
        assertTrue(sys.pool.extDataHash(changed) != h, "amount");
        changed = e;
        changed.relayer = ALICE;
        assertTrue(sys.pool.extDataHash(changed) != h, "relayer");
        changed = e;
        changed.fee = e.fee + 1;
        assertTrue(sys.pool.extDataHash(changed) != h, "fee");
        changed = e;
        changed.note0 = hex"ab";
        assertTrue(sys.pool.extDataHash(changed) != h, "note0");
        changed = e;
        changed.note1 = hex"cd";
        assertTrue(sys.pool.extDataHash(changed) != h, "note1");
        vm.chainId(4663);
        assertTrue(sys.pool.extDataHash(e) != h, "chain id");
    }
}
