// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Curve} from "./Curve.sol";

/// @dev Checks one Groth16 proof of the `transact` circuit.
interface IVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[16] calldata pubSignals
    ) external view returns (bool);
}

/// @dev Poseidon hash of two field elements, as the circuit computes it.
interface IHasher {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// @title Shielded pool for ETH
/// @notice Holds ETH against note commitments. A movement of value is accepted only with a
///         zero-knowledge proof from the `transact` circuit. There is no upgrade path, and no
///         function moves ETH without a valid proof.
/// @dev The owner may pause new deposits, change deposit limits and replace the auditor key after
///      a public delay. The owner can never move funds or stop transfers and withdrawals.
contract Pool {
    /// @dev Scalar field of BN254: the field of every hash and curve point of the protocol.
    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @dev Minimum public notice before a new auditor key can be activated.
    uint256 public constant AUDITOR_DELAY = 7 days;
    /// @dev Exclusive upper bound of every amount: notes cannot hold 2^96 wei or more.
    uint256 public constant AMOUNT_LIMIT = 1 << 96;
    /// @dev Gas handed to a payee. Enough for a wallet contract to accept ETH, too little to do harm.
    uint256 internal constant PAYOUT_GAS = 50_000;
    /// @dev Poseidon(1, 2). Any hasher that does not return this is not the hasher of the circuit.
    uint256 internal constant POSEIDON_1_2 = 7853200120776062878684798364095072458815029376092732009249414926327459813530;

    /// @notice A proof together with the public signals that come from calldata.
    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256 root;
        uint256[2] nullifiers;
        uint256[2] commitments;
        uint256[2] auditEphemeral;
        uint256[5] auditCipher;
    }

    /// @notice Everything outside the proof that the proof is bound to.
    struct ExtData {
        // solhint-disable-next-line var-name-mixedcase
        address recipient; // receives a withdrawal
        // solhint-disable-next-line var-name-mixedcase
        int256 extAmount; // > 0 deposit, < 0 withdrawal, 0 transfer
        // solhint-disable-next-line var-name-mixedcase
        address relayer; // receives the fee
        // solhint-disable-next-line var-name-mixedcase
        uint256 fee;
        // solhint-disable-next-line var-name-mixedcase
        bytes note0; // encrypted note for the owner of commitment 0
        // solhint-disable-next-line var-name-mixedcase
        bytes note1;
    }

    // ----------------------------------------------------------------- state

    IVerifier public immutable verifier;
    IHasher public immutable hasher;
    uint32 public immutable levels;
    uint32 public immutable rootHistorySize;

    address public owner;
    address public pendingOwner;

    bool public depositsPaused;
    uint256 public maxDeposit;
    uint256 public poolCap;
    /// @notice ETH owed to notes. Tracked separately so ETH forced into the pool changes nothing.
    uint256 public totalHeld;

    uint256[2] internal _auditorKey;
    uint256[2] internal _pendingAuditorKey;
    /// @notice Timestamp from which a proposed auditor key can be activated; 0 when none is pending.
    uint256 public pendingAuditorEta;

    /// @notice ETH a payee could not accept when it was paid; it collects it with claim().
    mapping(address => uint256) public owed;

    mapping(uint256 => bool) public nullifierSpent;
    /// @notice True for each root a proof may currently be built on.
    mapping(uint256 => bool) public rootKnown;
    /// @dev Ring of the `rootHistorySize` most recent roots.
    mapping(uint256 => uint256) internal _roots;
    /// @dev `_zeros[i]` is the root of an empty subtree of height `i`.
    mapping(uint256 => uint256) internal _zeros;
    /// @dev `_filledSubtrees[level]` is the finished left sibling waiting at that level.
    mapping(uint256 => uint256) internal _filledSubtrees;
    uint32 public currentRootIndex;
    /// @notice Index of the next free leaf.
    uint32 public nextIndex;

    uint256 private _lock = 1;

    // ----------------------------------------------------------------- events

    /// @notice A note commitment was added to the tree, with the encrypted note for its owner.
    event NewCommitment(uint256 indexed commitment, uint32 index, bytes note);
    /// @notice A note was spent.
    event NewNullifier(uint256 indexed nullifier);
    /// @notice One transaction's copy sealed to the auditor key.
    event AuditRecord(uint256 indexed nullifier0, uint256[2] ephemeral, uint256[5] cipher, uint256[2] auditorKey);
    /// @notice ETH entered the pool.
    event Deposit(address indexed from, uint256 amount);
    /// @notice ETH was paid out to a recipient.
    event Withdrawal(address indexed to, uint256 amount);
    /// @notice A relayer received its fee.
    event RelayerPaid(address indexed relayer, uint256 fee);
    /// @notice A payee did not accept its ETH; it waits in owed[].
    event PaymentHeld(address indexed to, uint256 amount);
    /// @notice A payee collected what was held for it.
    event Claimed(address indexed to, uint256 amount);
    /// @notice The owner proposed a new auditor key.
    event AuditorProposed(uint256 x, uint256 y, uint256 eta);
    /// @notice The auditor key in force changed (also at construction).
    event AuditorChanged(uint256 x, uint256 y);
    /// @notice New deposits are paused or allowed again.
    event DepositsPaused(bool paused);
    /// @notice Deposit limits changed (also at construction).
    event LimitsChanged(uint256 maxDeposit, uint256 poolCap);
    /// @notice The owner named a new owner, who has to accept.
    event OwnershipTransferStarted(address indexed from, address indexed to);
    /// @notice Ownership moved (also at construction).
    event OwnershipTransferred(address indexed from, address indexed to);

    // ----------------------------------------------------------------- errors

    /// @notice A constructor argument is missing or out of range.
    error BadConfig();
    /// @notice The hasher does not compute the circuit's Poseidon.
    error BadHasher();
    /// @notice The point is not a non-identity point of the curve's prime-order subgroup.
    error BadAuditorKey();
    /// @notice The caller is not allowed to do this.
    error NotOwner();
    /// @notice The zero address cannot own the pool.
    error ZeroAddress();
    /// @notice Reentrant call.
    error Reentered();
    /// @notice The root of the proof is not one of the roots the pool still knows.
    error UnknownRoot();
    /// @notice The fee or the public amount is not below 2^96.
    error AmountOutOfRange();
    /// @notice A public signal is not a field element.
    error SignalOutOfRange();
    /// @notice The nullifier was spent before.
    error NullifierUsed();
    /// @notice The verifier rejected the proof.
    error InvalidProof();
    /// @notice msg.value does not match the action.
    error WrongValue();
    /// @notice Deposit while deposits are paused.
    error DepositsArePaused();
    /// @notice Deposit above the per-deposit limit.
    error DepositTooLarge();
    /// @notice The deposit would push the pool above its cap.
    error PoolCapReached();
    /// @notice A withdrawal or a fee has no payee.
    error NoRecipient();
    /// @notice The pool itself cannot be a payee: it could never collect.
    error BadPayee();
    /// @notice Every leaf of the tree is used.
    error TreeFull();
    /// @notice Nothing is held for the caller.
    error NothingOwed();
    /// @notice The caller did not accept the ETH held for it.
    error TransferFailed();
    /// @notice No auditor key change is pending.
    error NothingPending();
    /// @notice The public delay of the auditor key change has not passed.
    error TooEarly();

    // ----------------------------------------------------------------- guards

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentered();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------- constructor

    /// @param verifier_ Groth16 verifier of the `transact` circuit.
    /// @param hasher_ Poseidon hasher of the tree.
    /// @param levels_ Tree depth. Must equal the depth compiled into the circuit.
    /// @param rootHistorySize_ Number of recent roots a proof may be built on.
    /// @param auditorKey_ Auditor public key as `[x, y]`.
    /// @param maxDeposit_ Largest deposit in wei.
    /// @param poolCap_ Largest `totalHeld` in wei.
    /// @param owner_ Owner of the pool.
    constructor(
        IVerifier verifier_,
        IHasher hasher_,
        uint32 levels_,
        uint32 rootHistorySize_,
        uint256[2] memory auditorKey_,
        uint256 maxDeposit_,
        uint256 poolCap_,
        address owner_
    ) {
        if (address(verifier_) == address(0) || address(hasher_) == address(0)) revert BadConfig();
        if (levels_ == 0 || levels_ > 31 || rootHistorySize_ == 0) revert BadConfig();
        if (owner_ == address(0)) revert BadConfig();
        if (hasher_.poseidon([uint256(1), uint256(2)]) != POSEIDON_1_2) revert BadHasher();
        if (!Curve.isAuditorKey(auditorKey_[0], auditorKey_[1])) revert BadAuditorKey();

        verifier = verifier_;
        hasher = hasher_;
        levels = levels_;
        rootHistorySize = rootHistorySize_;
        _auditorKey = auditorKey_;
        maxDeposit = maxDeposit_;
        poolCap = poolCap_;
        owner = owner_;

        // Empty leaf is 0; _zeros[i] is the root of an empty subtree of height i.
        uint256 zero = 0;
        for (uint32 i = 0; i < levels_; i++) {
            _zeros[i] = zero;
            zero = hasher_.poseidon([zero, zero]);
        }
        _roots[0] = zero;
        rootKnown[zero] = true;

        emit AuditorChanged(auditorKey_[0], auditorKey_[1]);
        emit LimitsChanged(maxDeposit_, poolCap_);
        emit OwnershipTransferred(address(0), owner_);
    }

    // ------------------------------------------------------------------ receive

    /// @notice The only way value moves. `msg.value` is the deposit, if any.
    /// @param proof The Groth16 proof and the public signals taken from calldata.
    /// @param extData Recipient, public amount, relayer, fee and the two encrypted notes.
    function transact(Proof calldata proof, ExtData calldata extData) external payable nonReentrant {
        if (!rootKnown[proof.root]) revert UnknownRoot();
        if (!_amountsInRange(extData)) revert AmountOutOfRange();
        _checkPayees(extData);
        _checkSignalRanges(proof);

        // Marking the first before checking the second also refuses a repeated nullifier.
        for (uint256 i = 0; i < 2; i++) {
            uint256 nullifier = proof.nullifiers[i];
            if (nullifierSpent[nullifier]) revert NullifierUsed();
            nullifierSpent[nullifier] = true;
            emit NewNullifier(nullifier);
        }

        if (!verifier.verifyProof(proof.a, proof.b, proof.c, _publicSignals(proof, extData))) revert InvalidProof();

        uint256 withdrawn = 0;
        if (extData.extAmount > 0) {
            uint256 amount = uint256(extData.extAmount);
            if (depositsPaused) revert DepositsArePaused();
            if (msg.value != amount) revert WrongValue();
            if (amount > maxDeposit) revert DepositTooLarge();
            totalHeld += amount;
            if (totalHeld > poolCap) revert PoolCapReached();
            emit Deposit(msg.sender, amount);
        } else {
            if (msg.value != 0) revert WrongValue();
            if (extData.extAmount < 0) withdrawn = uint256(-extData.extAmount);
        }

        uint32 index = _insertPair(proof.commitments[0], proof.commitments[1]);
        emit NewCommitment(proof.commitments[0], index, extData.note0);
        emit NewCommitment(proof.commitments[1], index + 1, extData.note1);
        emit AuditRecord(proof.nullifiers[0], proof.auditEphemeral, proof.auditCipher, _auditorKey);

        // Books first, payments last. A payee that refuses its ETH cannot undo the
        // transaction: the amount waits for it in `owed`. Without this, a recipient contract
        // could make a relayer's transaction fail after the relayer had paid for it.
        totalHeld -= withdrawn + extData.fee;
        if (withdrawn > 0) {
            _pay(extData.recipient, withdrawn);
            emit Withdrawal(extData.recipient, withdrawn);
        }
        if (extData.fee > 0) {
            _pay(extData.relayer, extData.fee);
            emit RelayerPaid(extData.relayer, extData.fee);
        }
    }

    /// @notice Collects ETH that could not be delivered earlier.
    function claim() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice The hash every proof is bound to. Includes this chain and this contract,
    ///         so a proof cannot be replayed anywhere else.
    function extDataHash(ExtData calldata extData) public view returns (uint256) {
        return uint256(
            keccak256(
                abi.encode(
                    extData.recipient,
                    extData.extAmount,
                    extData.relayer,
                    extData.fee,
                    keccak256(extData.note0),
                    keccak256(extData.note1),
                    block.chainid,
                    address(this)
                )
            )
        ) % FIELD;
    }

    /// @notice Can a proof be built on this root right now?
    function isKnownRoot(uint256 root) public view returns (bool) {
        return rootKnown[root];
    }

    /// @notice The current root of the commitment tree.
    function lastRoot() external view returns (uint256) {
        return _roots[currentRootIndex];
    }

    /// @notice The root stored at a position of the history ring.
    function rootAt(uint256 position) external view returns (uint256) {
        return _roots[position];
    }

    /// @notice The auditor key in force, as `[x, y]`.
    function auditorKey() external view returns (uint256[2] memory) {
        return _auditorKey;
    }

    /// @notice The proposed auditor key, as `[x, y]`. Zero when nothing is pending.
    function pendingAuditorKey() external view returns (uint256[2] memory) {
        return _pendingAuditorKey;
    }

    /// @notice The 16 public signals the verifier receives for one transaction.
    function publicSignals(Proof calldata proof, ExtData calldata extData) external view returns (uint256[16] memory) {
        return _publicSignals(proof, extData);
    }

    // ------------------------------------------------------------------ internals of transact

    /// @dev The pool computes the public amount, so the prover cannot choose it freely.
    function _publicSignals(Proof calldata proof, ExtData calldata extData)
        private
        view
        returns (uint256[16] memory s)
    {
        int256 publicAmount = extData.extAmount - int256(extData.fee);
        s[0] = proof.root;
        s[1] = publicAmount >= 0 ? uint256(publicAmount) : FIELD - uint256(-publicAmount);
        s[2] = extDataHash(extData);
        s[3] = proof.nullifiers[0];
        s[4] = proof.nullifiers[1];
        s[5] = proof.commitments[0];
        s[6] = proof.commitments[1];
        s[7] = _auditorKey[0];
        s[8] = _auditorKey[1];
        s[9] = proof.auditEphemeral[0];
        s[10] = proof.auditEphemeral[1];
        for (uint256 i = 0; i < 5; i++) s[11 + i] = proof.auditCipher[i];
    }

    function _amountsInRange(ExtData calldata extData) private pure returns (bool) {
        return extData.fee < AMOUNT_LIMIT && extData.extAmount < int256(AMOUNT_LIMIT)
            && extData.extAmount > -int256(AMOUNT_LIMIT);
    }

    function _checkPayees(ExtData calldata extData) private view {
        if (extData.extAmount < 0) {
            if (extData.recipient == address(0)) revert NoRecipient();
            if (extData.recipient == address(this)) revert BadPayee();
        }
        if (extData.fee > 0) {
            if (extData.relayer == address(0)) revert NoRecipient();
            if (extData.relayer == address(this)) revert BadPayee();
        }
    }

    /// @dev The verifier refuses signals outside the field too. The pool states it for the
    ///      signals it takes from calldata, so that using a nullifier as a mapping key and a
    ///      commitment as a tree leaf never depends on a generated contract.
    function _checkSignalRanges(Proof calldata proof) private pure {
        for (uint256 i = 0; i < 2; i++) {
            if (
                proof.nullifiers[i] >= FIELD || proof.commitments[i] >= FIELD || proof.auditEphemeral[i] >= FIELD
            ) revert SignalOutOfRange();
        }
        for (uint256 i = 0; i < 5; i++) {
            if (proof.auditCipher[i] >= FIELD) revert SignalOutOfRange();
        }
    }

    /// @dev Sends with a small gas stipend. A payee that refuses does not fail the transaction.
    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount, gas: PAYOUT_GAS}("");
        if (!ok) {
            owed[to] += amount;
            emit PaymentHeld(to, amount);
        }
    }

    // ------------------------------------------------------------------ commitment tree

    /// @dev Adds two leaves side by side. Every transaction adds exactly two, so the pair
    ///      always starts at an even position.
    function _insertPair(uint256 leaf0, uint256 leaf1) private returns (uint32 index) {
        index = nextIndex;
        if (uint256(index) + 2 > (uint256(1) << levels)) revert TreeFull();

        uint256 node = hasher.poseidon([leaf0, leaf1]);
        uint32 pos = index >> 1;
        for (uint32 level = 1; level < levels; level++) {
            if (pos & 1 == 0) {
                _filledSubtrees[level] = node;
                node = hasher.poseidon([node, _zeros[level]]);
            } else {
                node = hasher.poseidon([_filledSubtrees[level], node]);
            }
            pos >>= 1;
        }

        uint32 next = (currentRootIndex + 1) % rootHistorySize;
        uint256 replaced = _roots[next];
        if (replaced != 0) delete rootKnown[replaced];
        _roots[next] = node;
        rootKnown[node] = true;
        currentRootIndex = next;
        nextIndex = index + 2;
    }

    // ------------------------------------------------------------------ auditor key

    /// @notice Proposes a new auditor key. It can be activated after `AUDITOR_DELAY`.
    /// @dev Overwrites an earlier proposal.
    function proposeAuditor(uint256 x, uint256 y) external onlyOwner {
        if (!Curve.isAuditorKey(x, y)) revert BadAuditorKey();
        _pendingAuditorKey = [x, y];
        pendingAuditorEta = block.timestamp + AUDITOR_DELAY;
        emit AuditorProposed(x, y, pendingAuditorEta);
    }

    /// @notice Makes the proposed auditor key current. Anyone may call it once the delay has passed.
    function activateAuditor() external {
        if (pendingAuditorEta == 0) revert NothingPending();
        if (block.timestamp < pendingAuditorEta) revert TooEarly();
        _auditorKey = _pendingAuditorKey;
        delete _pendingAuditorKey;
        pendingAuditorEta = 0;
        emit AuditorChanged(_auditorKey[0], _auditorKey[1]);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Stops or resumes new deposits. Transfers and withdrawals are never affected.
    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    /// @notice Changes the deposit limits. Never touches funds already inside.
    function setLimits(uint256 maxDeposit_, uint256 poolCap_) external onlyOwner {
        maxDeposit = maxDeposit_;
        poolCap = poolCap_;
        emit LimitsChanged(maxDeposit_, poolCap_);
    }

    /// @notice Names the next owner. The new owner has to call acceptOwnership().
    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    /// @notice Accepts ownership.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
