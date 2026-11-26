// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixture} from "./Fixture.sol";
import {Curve} from "../src/Curve.sol";
import {FixtureData} from "./FixtureData.sol";

contract CurveHarness {
    function onCurve(uint256 x, uint256 y) external pure returns (bool) {
        return Curve.isOnCurve(x, y);
    }

    function inSubgroup(uint256 x, uint256 y) external pure returns (bool) {
        return Curve.isInSubgroup(x, y);
    }

    function auditorKey(uint256 x, uint256 y) external pure returns (bool) {
        return Curve.isAuditorKey(x, y);
    }

    function gasOf(uint256 x, uint256 y) external returns (uint256) {
        uint256 before = gasleft();
        Curve.isAuditorKey(x, y);
        return before - gasleft();
    }
}

/// The points come from scripts/gen-fixtures.mjs, which classifies them with independent
/// BigInt arithmetic (multiplying by the subgroup order and comparing with the identity).
contract CurveTest is Fixture {
    CurveHarness internal curve;

    function setUp() public override {
        super.setUp();
        curve = new CurveHarness();
    }

    function test_AcceptsSubgroupPoints(uint256 i) public {
        uint256[2][5] memory valid = FixtureData.validKeys();
        i = bound(i, 0, FixtureData.VALID_KEY_COUNT - 1);
        assertTrue(curve.auditorKey(valid[i][0], valid[i][1]), "valid key refused");
    }

    function test_RefusesEverythingElse(uint256 i) public {
        uint256[2][12] memory invalid = FixtureData.invalidKeys();
        i = bound(i, 0, FixtureData.INVALID_KEY_COUNT - 1);
        assertFalse(curve.auditorKey(invalid[i][0], invalid[i][1]), "invalid key accepted");
    }

    function test_EveryInvalidKeyIsRefused() public {
        uint256[2][12] memory invalid = FixtureData.invalidKeys();
        for (uint256 i = 0; i < FixtureData.INVALID_KEY_COUNT; i++) {
            uint256 x = invalid[i][0];
            uint256 y = invalid[i][1];
            assertFalse(curve.auditorKey(x, y), string.concat("invalid key ", vm.toString(i), " accepted"));
            // Points on the curve that are refused are refused for not being in the subgroup.
            if (x != 0 && curve.onCurve(x, y)) assertFalse(curve.inSubgroup(x, y));
        }
        emit log_named_uint("invalid keys checked", FixtureData.INVALID_KEY_COUNT);
    }

    /// The identity is on the curve and in the subgroup; only the x != 0 rule keeps it out.
    function test_IdentityAndOrderTwo() public {
        assertTrue(curve.onCurve(0, 1));
        assertTrue(curve.inSubgroup(0, 1));
        assertFalse(curve.auditorKey(0, 1));
        // (0, -1) has order 2: on the curve, x = 0 like the identity, but not in the subgroup.
        assertTrue(curve.onCurve(0, FIELD - 1));
        assertFalse(curve.inSubgroup(0, FIELD - 1));
        assertFalse(curve.auditorKey(0, FIELD - 1));
    }

    function test_RandomPairsAreNotPoints(uint256 x, uint256 y) public {
        x = bound(x, 1, FIELD - 1);
        y = bound(y, 1, FIELD - 1);
        assertFalse(curve.onCurve(x, y));
    }

    function test_OutsideTheFieldIsNotAPoint() public {
        assertFalse(curve.onCurve(FIELD, 1));
        assertFalse(curve.onCurve(1, FIELD + 5));
    }

    function test_Gas() public {
        uint256 x = FixtureData.AUDITOR_X;
        uint256 y = FixtureData.AUDITOR_Y;
        curve.gasOf(x, y);
        emit log_named_uint("auditor key check gas", curve.gasOf(x, y));
    }
}
