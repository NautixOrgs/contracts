// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Address book for shielded addresses
/// @notice Lets a wallet publish the two public keys others need to pay it privately: the key
///         that owns its notes and the key its notes are encrypted to. A payer then only needs
///         the recipient's ordinary address.
/// @dev Holds no funds and has no owner. A wrong entry misdirects a payment at worst; the
///      entry can only be written by the address it describes.
contract Registry {
    /// @dev The field the spending public key lives in.
    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice The shielded address of one wallet.
    /// @param pubKey Public key that owns the wallet's notes.
    /// @param encKey Public key the wallet's notes are encrypted to.
    struct Entry {
        uint256 pubKey;
        bytes32 encKey;
    }

    mapping(address => Entry) public entries;

    /// @notice A wallet published or replaced its shielded address.
    event Registered(address indexed account, uint256 pubKey, bytes32 encKey);

    /// @notice A key is zero, outside the field, or empty.
    error BadKey();

    /// @notice Publishes the caller's shielded address. Registering again replaces it.
    /// @param pubKey Public key that owns the caller's notes: 1 <= pubKey < FIELD.
    /// @param encKey Public key the caller's notes are encrypted to; not zero.
    function register(uint256 pubKey, bytes32 encKey) external {
        if (pubKey == 0 || pubKey >= FIELD || encKey == bytes32(0)) revert BadKey();
        entries[msg.sender] = Entry(pubKey, encKey);
        emit Registered(msg.sender, pubKey, encKey);
    }
}
