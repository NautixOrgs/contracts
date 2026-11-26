// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hasher} from "../src/Hasher.sol";
import {FixtureData} from "./FixtureData.sol";

contract HasherTest is Test {
    Hasher internal hasher;

    function setUp() public {
        hasher = new Hasher();
    }

    /// The vectors were produced by circomlibjs, the wasm library the circuit is checked against.
    function test_PoseidonAgreesWithTheReferenceLibrary(uint256 i) public {
        FixtureData.Vector[] memory v = FixtureData.vectors();
        i = bound(i, 0, v.length - 1);
        assertEq(hasher.poseidon([v[i].a, v[i].b]), v[i].expected);
    }

    function test_EveryVector() public {
        FixtureData.Vector[] memory v = FixtureData.vectors();
        for (uint256 i = 0; i < v.length; i++) {
            assertEq(hasher.poseidon([v[i].a, v[i].b]), v[i].expected, string.concat("vector ", vm.toString(i)));
        }
        emit log_named_uint("vectors checked", v.length);
    }

    function test_KnownValues() public {
        assertEq(hasher.poseidon([uint256(1), uint256(2)]), 7853200120776062878684798364095072458815029376092732009249414926327459813530);
        // poseidon-lite agrees on this one.
        assertEq(hasher.poseidon([uint256(0), uint256(0)]), 14744269619966411208579211824598458697587494354926760081771325075741142829156);
    }

    /// The chain of zero subtrees must end in the root every pool of depth 24 starts from.
    function test_EmptyTreeRootOfDepth24() public {
        uint256 zero = 0;
        for (uint256 i = 0; i < 24; i++) zero = hasher.poseidon([zero, zero]);
        // A literal, not a generated constant, so the check has a second opinion.
        assertEq(zero, 17681057402012993898104192736393849603097507831571622013521167331642182653248);
        assertEq(zero, FixtureData.EMPTY_ROOT);
    }

    function test_Gas() public {
        uint256[2] memory in_ = [uint256(1), uint256(2)];
        hasher.poseidon(in_);
        uint256 before = gasleft();
        hasher.poseidon(in_);
        emit log_named_uint("poseidon gas", before - gasleft());
    }
}
