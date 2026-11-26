// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixture} from "./Fixture.sol";
import {Pool} from "../src/Pool.sol";
import {Groth16Verifier} from "../src/Verifier.sol";
import {FixtureData} from "./FixtureData.sol";

contract VerifierTest is Fixture {
    Groth16Verifier internal verifier;

    function setUp() public override {
        super.setUp();
        verifier = new Groth16Verifier();
    }

    /// The proof was made off-chain with the proving key the verifier was generated from.
    function test_AcceptsARealProof() public {
        Pool.Proof memory p = _proof("a_deposit_1");
        assertTrue(verifier.verifyProof(p.a, p.b, p.c, _signals("a_deposit_1")));
    }

    function test_RefusesEveryChangedPublicSignal(uint256 i) public {
        i = bound(i, 0, 15);
        Pool.Proof memory p = _proof("a_deposit_1");
        uint256[16] memory s = _signals("a_deposit_1");
        s[i] = addmod(s[i], 1, FIELD);
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, s), "signal changed");
    }

    function test_RefusesChangedProofPoints() public {
        uint256[16] memory s = _signals("a_deposit_1");
        Pool.Proof memory p = _proof("a_deposit_1");
        p.a[0] = addmod(p.a[0], 1, FIELD);
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, s));

        p = _proof("a_deposit_1");
        p.b[1][0] = addmod(p.b[1][0], 1, FIELD);
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, s));

        p = _proof("a_deposit_1");
        p.c[1] = addmod(p.c[1], 1, FIELD);
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, s));

        p = _proof("a_deposit_1");
        p.a = [uint256(0), uint256(0)];
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, s));
    }

    /// A value at or above the scalar field would otherwise be a second spelling of another signal.
    function test_RefusesSignalsOutsideTheField(uint256 i) public {
        i = bound(i, 0, 15);
        Pool.Proof memory p = _proof("a_deposit_1");
        uint256[16] memory s = _signals("a_deposit_1");
        s[i] = FIELD + s[i];
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, s));
        s[i] = FIELD;
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, s));
    }

    function test_RefusesAnotherTransactionsSignals() public {
        Pool.Proof memory p = _proof("a_deposit_1");
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, _signals("a_deposit_2")));
    }

    /// Every proof of the fixtures verifies with exactly the signals recorded when it was made.
    function test_EveryFixtureProofVerifies() public {
        FixtureData.Step[] memory all = FixtureData.steps();
        for (uint256 i = 0; i < all.length; i++) {
            Pool.Proof memory p = all[i].proof;
            assertTrue(verifier.verifyProof(p.a, p.b, p.c, all[i].publicSignals), all[i].name);
        }
        emit log_named_uint("proofs verified", all.length);
    }

    function test_Gas() public {
        Pool.Proof memory p = _proof("a_deposit_1");
        uint256[16] memory s = _signals("a_deposit_1");
        verifier.verifyProof(p.a, p.b, p.c, s);
        uint256 before = gasleft();
        verifier.verifyProof(p.a, p.b, p.c, s);
        emit log_named_uint("verifyProof gas", before - gasleft());
    }
}
