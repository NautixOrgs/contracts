// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVerifier} from "../../src/Pool.sol";

/// @dev Test only. Accepts every proof, so tree limits and state rules can be reached cheaply.
contract AcceptAllVerifier is IVerifier {
    uint256 public calls;

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[16] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// @dev Test only. Calls the pool again from its receive function, with calldata set beforehand.
contract Reenter {
    address public pool;
    bytes public data;
    bool public tried;
    bool public innerCallSucceeded;

    function arm(address pool_, bytes calldata data_) external {
        pool = pool_;
        data = data_;
        tried = false;
        innerCallSucceeded = false;
    }

    /// @dev claim() pays with all the gas left, so the re-entry really runs.
    function collect() external {
        (bool ok,) = pool.call(abi.encodeWithSignature("claim()"));
        require(ok, "claim failed");
    }

    receive() external payable {
        if (!tried && pool != address(0)) {
            tried = true;
            (bool ok,) = pool.call(data);
            innerCallSucceeded = ok;
        }
    }
}

/// @dev Test only. Refuses ETH until told to accept it, and can collect what it is owed.
contract Refuser {
    bool public accepting;

    function setAccepting(bool on) external {
        accepting = on;
    }

    function collect(address pool) external {
        (bool ok, bytes memory why) = pool.call(abi.encodeWithSignature("claim()"));
        if (!ok) {
            assembly {
                revert(add(why, 32), mload(why))
            }
        }
    }

    receive() external payable {
        require(accepting, "no thanks");
    }
}

/// @dev Test only. Pushes ETH into an address that has no way to refuse it.
contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// @dev Test only. Answers 0 to every hash, so it is not the hasher of the circuit.
contract BadHasher {
    function poseidon(uint256[2] calldata) external pure returns (uint256) {
        return 0;
    }
}
