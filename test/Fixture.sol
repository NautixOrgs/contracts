// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Pool, IVerifier, IHasher} from "../src/Pool.sol";
import {Hasher} from "../src/Hasher.sol";
import {Groth16Verifier} from "../src/Verifier.sol";
import {Registry} from "../src/Registry.sol";
import {AcceptAllVerifier} from "./mocks/TestHelpers.sol";
import {FixtureData} from "./FixtureData.sol";

/// @dev Shared by the contract tests. Deploys the four contracts from a fixed deployer at fixed
///      nonces, so that the pool always lands on the address that the real proofs are made for,
///      and gives access to the proved storyline in FixtureData.
abstract contract Fixture is Test {
    address internal constant DEPLOYER = address(0xA11CE);
    address internal constant ALICE = address(0x1001);
    address internal constant BOB = address(0x1002);
    address internal constant OWNER = address(0xC0FFEE);
    address internal constant RELAYER = address(0xBEEF);
    address internal constant WITHDRAW_TO = address(0xCAFE);
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant ETH = 1 ether;
    uint256 internal constant MAX_DEPOSIT = 0.1 ether;
    uint256 internal constant POOL_CAP = 5 ether;

    struct System {
        Hasher hasher;
        Groth16Verifier verifier;
        Pool pool;
        Registry registry;
    }

    /// @dev The main storyline in order.
    string[6] internal MAIN_STORYLINE = ["a_deposit_1", "a_deposit_2", "a_pay_bob", "b_withdraw", "a_merge", "a_withdraw"];


    function setUp() public virtual {
        vm.chainId(FixtureData.CHAIN_ID);
        vm.deal(DEPLOYER, 1000 ether);
        vm.deal(OWNER, 1000 ether);
        vm.deal(ALICE, 1000 ether);
        vm.deal(BOB, 1000 ether);
        vm.deal(RELAYER, 1000 ether);
    }

    // ------------------------------------------------------------------ fixtures

    function _step(string memory name) internal pure returns (FixtureData.Step memory) {
        return FixtureData.step(FixtureData.stepIndex(name));
    }

    function _proof(string memory name) internal returns (Pool.Proof memory) {
        return _step(name).proof;
    }

    function _ext(string memory name) internal returns (Pool.ExtData memory) {
        return _step(name).ext;
    }

    function _signals(string memory name) internal returns (uint256[16] memory) {
        return _step(name).publicSignals;
    }

    function _rootAfter(string memory name) internal returns (uint256) {
        return _step(name).rootAfter;
    }

    function _same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    // ------------------------------------------------------------------ deployment

    /// @param verifier_ The verifier the pool uses. The zero address means the Groth16Verifier
    ///        deployed in this run. The pool is always the third contract the deployer creates,
    ///        so it always sits on the address the proofs are made for.
    function _deploy(
        IVerifier verifier_,
        uint32 levels,
        uint32 history,
        uint256[2] memory auditorKey,
        uint256 maxDeposit,
        uint256 poolCap,
        address owner
    ) internal returns (System memory sys) {
        vm.startPrank(DEPLOYER);
        sys.hasher = new Hasher(); // nonce 0
        sys.verifier = new Groth16Verifier(); // nonce 1
        sys.pool = new Pool(
            address(verifier_) == address(0) ? IVerifier(address(sys.verifier)) : verifier_,
            IHasher(address(sys.hasher)),
            levels,
            history,
            auditorKey,
            maxDeposit,
            poolCap,
            owner
        ); // nonce 2
        sys.registry = new Registry(); // nonce 3
        vm.stopPrank();
    }

    /// The full system with the real verifier and the default limits. Its
    /// first use in a test puts the pool on the address the proofs are made for.
    function _deployReal(uint32 history) internal returns (System memory sys) {
        sys = _deploy(IVerifier(address(0)), 24, history, [FixtureData.AUDITOR_X, FixtureData.AUDITOR_Y], MAX_DEPOSIT, POOL_CAP, OWNER);
        assertEq(address(sys.pool), FixtureData.POOL, "the pool must sit on the address the proofs are made for");
    }

    /// A pool whose verifier accepts every proof: for state rules that need no proof.
    function _deployOpen(uint32 levels, uint32 history) internal returns (System memory sys) {
        return _deploy(IVerifier(address(new AcceptAllVerifier())), levels, history, [FixtureData.AUDITOR_X, FixtureData.AUDITOR_Y], MAX_DEPOSIT, POOL_CAP, OWNER);
    }

    // ------------------------------------------------------------------ sending

    /// @notice Submits a transaction of the storyline. Returns false instead of reverting.
    /// @dev The sender pays the deposit, if the transaction is one.
    function _try(System memory sys, string memory name, address from) internal returns (bool ok) {
        Pool.Proof memory p = _proof(name);
        Pool.ExtData memory e = _ext(name);
        uint256 value = e.extAmount > 0 ? uint256(e.extAmount) : 0;
        vm.prank(from);
        (ok,) = address(sys.pool).call{value: value}(abi.encodeCall(Pool.transact, (p, e)));
    }

    /// Submits a proof and external data of your choosing.
    function _tryWith(Pool pool, Pool.Proof memory p, Pool.ExtData memory e, uint256 value, address from)
        internal
        returns (bool ok)
    {
        vm.prank(from);
        (ok,) = address(pool).call{value: value}(abi.encodeCall(Pool.transact, (p, e)));
    }

    function _must(System memory sys, string memory name, address from) internal {
        assertTrue(_try(sys, name, from), name);
    }

    /// @notice Expects a specific error from a storyline transaction.
    function _refused(System memory sys, string memory name, address from, bytes4 error) internal {
        vm.expectRevert(error);
        _try(sys, name, from);
    }

    /// @notice The wallet that submits a storyline transaction: the relayer for the relayed
    ///         transfer, Bob for his own withdrawal, Alice for the rest.
    function _senderOf(string memory name) internal view returns (address) {
        if (_same(name, "a_pay_bob")) return RELAYER;
        if (_same(name, "b_withdraw")) return BOB;
        return ALICE;
    }

    /// Plays the main storyline from the start up to and including `last`.
    function _play(System memory sys, string memory last) internal {
        bool reached = false;
        for (uint256 i = 0; i < MAIN_STORYLINE.length; i++) {
            string memory name = MAIN_STORYLINE[i];
            assertTrue(_try(sys, name, _senderOf(name)), name);
            assertEq(sys.pool.lastRoot(), _rootAfter(name), "root after the step");
            reached = _same(name, last);
            if (reached) break;
        }
        assertTrue(reached, "not part of the main storyline");
    }

    /// Plays the root-history storyline's three deposits.
    function _playHistory(System memory sys) internal {
        _must(sys, "h_deposit_1", ALICE);
        _must(sys, "h_deposit_2", ALICE);
        _must(sys, "h_deposit_3", ALICE);
    }

    // ------------------------------------------------------------------ the open pool

    uint256 internal _leaf = 1;

    /// A made-up proof for the open pool. Curve points are zero; the pool never looks at them.
    function _blank(uint256 root, uint256 nullifier0, uint256 nullifier1) internal returns (Pool.Proof memory p) {
        p.root = root;
        p.nullifiers = [nullifier0, nullifier1];
        p.commitments = [_fresh(), _fresh()];
        p.auditEphemeral = [uint256(11), uint256(22)];
        p.auditCipher = [uint256(1), 2, 3, 4, 5];
    }

    /// A value below the field size: the pool refuses public signals outside the field.
    function _fresh() internal returns (uint256) {
        return uint256(keccak256(abi.encode(_leaf++))) >> 8;
    }

    function _emptyExt() internal pure returns (Pool.ExtData memory e) {
        e.note0 = hex"00";
        e.note1 = hex"00";
    }

    /// A withdrawal on the open pool: `amount` leaves to `to`, `fee` to the relayer.
    function _withdrawExt(address to, address via, uint256 amount, uint256 fee) internal pure returns (Pool.ExtData memory e) {
        e = _emptyExt();
        e.recipient = to;
        e.extAmount = -int256(amount);
        e.relayer = via;
        e.fee = fee;
    }

    function _depositExt(uint256 amount) internal pure returns (Pool.ExtData memory e) {
        e = _emptyExt();
        e.extAmount = int256(amount);
    }

    /// A made-up proof for the current root, to send with external data of your choice.
    function _proofFor(Pool pool) internal returns (Pool.Proof memory p) {
        return _blank(pool.lastRoot(), _fresh(), _fresh());
    }

    /// A transfer on the open pool: two fresh nullifiers, nothing entering or leaving.
    function _openTransfer(Pool pool) internal {
        pool.transact(_proofFor(pool), _emptyExt());
    }

    /// A withdrawal on the open pool: `amount` leaves to `to`, `fee` to the relayer.
    function _openWithdraw(Pool pool, address to, uint256 amount, uint256 fee) internal {
        pool.transact(_proofFor(pool), _withdrawExt(to, RELAYER, amount, fee));
    }

    /// A withdrawal whose fee goes to `via`.
    function _openWithdrawVia(Pool pool, address to, address via, uint256 amount, uint256 fee) internal {
        pool.transact(_proofFor(pool), _withdrawExt(to, via, amount, fee));
    }

    /// A deposit on the open pool: `amount` enters.
    function _openDeposit(Pool pool, address from, uint256 amount) internal {
        Pool.Proof memory p = _proofFor(pool);
        vm.prank(from);
        pool.transact{value: amount}(p, _depositExt(amount));
    }
}
