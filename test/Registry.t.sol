// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixture} from "./Fixture.sol";
import {Registry} from "../src/Registry.sol";

contract RegistryTest is Fixture {
    Registry internal registry;

    function setUp() public override {
        super.setUp();
        registry = new Registry();
    }

    function test_Register() public {
        uint256 pubKey = 12345;
        bytes32 encKey = keccak256("encryption key");
        vm.prank(ALICE);
        vm.expectEmit(true, true, true, true, address(registry));
        emit Registry.Registered(ALICE, pubKey, encKey);
        registry.register(pubKey, encKey);
        (uint256 storedKey, bytes32 storedEnc) = registry.entries(ALICE);
        assertEq(storedKey, pubKey);
        assertEq(storedEnc, encKey);
    }

    /// A wallet can replace its address, for example after moving to another device.
    function test_RegisterAgainReplaces() public {
        vm.startPrank(BOB);
        registry.register(1, bytes32(uint256(1)));
        registry.register(FIELD - 1, bytes32(uint256(2)));
        vm.stopPrank();
        (uint256 storedKey, bytes32 storedEnc) = registry.entries(BOB);
        assertEq(storedKey, FIELD - 1);
        assertEq(storedEnc, bytes32(uint256(2)));
        // Other addresses are untouched.
        (uint256 other,) = registry.entries(ALICE);
        assertEq(other, 0);
    }

    function test_RefusesBadKeys() public {
        vm.expectRevert(Registry.BadKey.selector);
        registry.register(0, bytes32(uint256(1)));
        vm.expectRevert(Registry.BadKey.selector);
        registry.register(FIELD, bytes32(uint256(1)));
        vm.expectRevert(Registry.BadKey.selector);
        registry.register(1, bytes32(0));
    }

    /// Only the address itself can write its entry.
    function test_EntryBelongsToTheCaller() public {
        vm.prank(ALICE);
        registry.register(7, bytes32(uint256(7)));
        (uint256 mine,) = registry.entries(address(this));
        assertEq(mine, 0);
    }

    /// No owner, no payable function, nothing to govern.
    function test_HasNoOwnerAndHoldsNoFunds() public {
        (bool ok,) = address(registry).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
        (bool sent,) = address(registry).call{value: 1}("");
        assertFalse(sent);
    }
}
