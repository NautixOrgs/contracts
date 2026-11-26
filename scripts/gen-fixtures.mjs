// Generates everything the Foundry tests need from the world of JavaScript and
// wasm, so that `forge test` runs without a witness calculator and without a network.
// test/fixtures/tree-vectors.json is read, not written: known-answer vectors for the tree.
//
//   test/fixtures/hasher-vectors.json  Poseidon(2) values from the wasm reference library
//   test/fixtures/curve-points.json    auditor keys that must be accepted or refused
//   test/fixtures/proofs.json          real Groth16 proofs for fixed storylines
//   test/FixtureData.sol               the same data as typed Solidity constants
//
//   node scripts/gen-fixtures.mjs            prove everything (about 20 seconds)
//   node scripts/gen-fixtures.mjs --reuse    only rewrite FixtureData.sol from the JSON files
//
// The proofs are bound to a pool address and a chain id. The tests therefore deploy the
// pool from a fixed deployer at a fixed nonce, and assert the address before using a proof.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getContractAddress, getAddress, keccak256, encodeAbiParameters } from "viem";
import { buildPoseidon } from "circomlibjs";
import * as C from "./lib/protocol.mjs";
import { prove, stopWorkers, toPoolProof, ZKEY, sha256 } from "./lib/witness.mjs";
import { randomCurvePoint, randomTorsionPoint, order4Point } from "../tests/helpers.mjs";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "test/fixtures");
const ETH = 10n ** 18n;
const CHAIN_ID = 46630;
const ZERO = "0x" + "00".repeat(20);
// Hasher is deployed at nonce 0, the verifier at 1, the pool at 2.
const DEPLOYER = "0x00000000000000000000000000000000000a11ce"; // address(0xA11CE) in the tests
const POOL = getContractAddress({ from: DEPLOYER, nonce: 2 });
const RELAYER = "0x000000000000000000000000000000000000beef"; // address(0xBEEF)
const WITHDRAW_TO = "0x000000000000000000000000000000000000cafe"; // address(0xCAFE)
const REUSE = process.argv.includes("--reuse");

const s = (v) => v.toString();

// Every "random" value below is a fixed hash, so each run produces the same notes and the
// same proofs (the proofs also depend on nothing but the circuit and the proving key).
const det = (salt, i) => C.H(BigInt(salt), BigInt(i));
const note = (salt, i, amount, pubKey) => ({ amount, pubKey, blinding: det(salt, i) });
const nonce = (salt, i) => det(salt, i + 1000) % (1n << 251n);

const alice = { sk: det(1, 0) }, bob = { sk: det(2, 0) };
alice.pk = C.pubKeyOf(alice.sk);
bob.pk = C.pubKeyOf(bob.sk);
const auditor = C.auditorKeyPair(det(3, 0) % (1n << 251n));
const nextAuditor = C.auditorKeyPair(det(4, 0) % (1n << 251n));

const EXT_TYPES = [
  { type: "address" }, { type: "int256" }, { type: "address" }, { type: "uint256" },
  { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" },
];
/** Must equal Pool.extDataHash. */
export function hashExt(ext, pool, chainId) {
  return BigInt(keccak256(encodeAbiParameters(EXT_TYPES, [
    ext.recipient, ext.extAmount, ext.relayer, ext.fee,
    keccak256(ext.note0), keccak256(ext.note1), BigInt(chainId), pool]))) % C.P;
}

const cloneTree = (tree) => structuredClone({ levels: tree.levels, zeros: tree.zeros, layers: tree.layers });
const restoreTree = (snap) => Object.assign(new C.Tree(snap.levels), snap);
const check = (ok, message) => { if (!ok) throw new Error(message); };

/**
 * Proves one transaction against the tree as it is.
 * Returns the pool-facing proof and external data, the notes it creates, and the public signals.
 */
async function makeTx(tree, { privKey, inputs = [], outputs = [], ext = {}, auditorPubKey = auditor.pubKey, chainId = CHAIN_ID, pool = POOL, salt, tag }) {
  const e = { recipient: ZERO, extAmount: 0n, relayer: ZERO, fee: 0n, note0: "0x", note1: "0x", ...ext };
  const built = C.buildTransaction({ tree, privKey, inputs, outputs, publicAmount: e.extAmount - e.fee,
    extDataHash: hashExt(e, pool, chainId), auditorPubKey, auditNonce: nonce(salt, tag) });
  const { proof, publicSignals } = await prove(built.signals);
  return {
    step: { ext: { ...e, extAmount: s(e.extAmount), fee: s(e.fee) }, proof: toPoolProof(proof, built.signals), publicSignals },
    built,
  };
}

/** A storyline: transactions proved one after another on a growing tree. */
class Story {
  constructor(salt) { this.salt = salt; this.tree = new C.Tree(); this.steps = {}; this.n = 0; }
  snapshot() { return cloneTree(this.tree); }
  /** Proves and adds the two commitments to the tree, as the pool will. */
  async add(name, args) {
    const tx = await makeTx(this.tree, { salt: this.salt, tag: this.n++, ...args });
    const index = tx.step.proof.commitments.map((c) => this.tree.insert(BigInt(c)));
    tx.step.index = index;
    tx.step.rootAfter = s(this.tree.root);
    tx.step.notes = tx.built.outputs.map((n) => ({ amount: s(n.amount), pubKey: s(n.pubKey), blinding: s(n.blinding) }));
    this.steps[name] = tx.step;
    console.log("  proved", name);
    return tx.step;
  }
  /** A note created by an earlier step, at the leaf index the pool gave it. */
  noteOf(name, i = 0) {
    const st = this.steps[name];
    return { note: { amount: BigInt(st.notes[i].amount), pubKey: BigInt(st.notes[i].pubKey), blinding: BigInt(st.notes[i].blinding) }, index: st.index[i] };
  }
}

mkdirSync(OUT, { recursive: true });
const file = (name) => join(OUT, name);

if (!REUSE) {
  // ---------------------------------------------------------------- Hasher vectors
  {
    const poseidon = await buildPoseidon(), F = poseidon.F;
    const vectors = [[1n, 2n], [0n, 0n], [0n, 1n], [1n, 0n], [C.P - 1n, C.P - 2n], [C.AMOUNT_LIMIT - 1n, 1n], [1n, C.AMOUNT_LIMIT]];
    for (let i = 0; i < 300; i++) vectors.push([C.randomField(), C.randomField()]);
    writeFileSync(file("hasher-vectors.json"), JSON.stringify({
      source: "circomlibjs (wasm) poseidon([a, b])",
      vectors: vectors.map(([a, b]) => ({ a: s(a), b: s(b), expected: F.toString(poseidon([a, b])) })),
    }) + "\n");
    console.log("hasher-vectors.json:", vectors.length, "vectors");
  }

  // ---------------------------------------------------------------- Curve points
  {
    const pick = () => { for (;;) { const p = randomCurvePoint(); if (!C.inSubgroup(p)) return p; } };
    const valid = [
      ["generator", C.BASE8], ["twice", C.pointMul(C.BASE8, 2n)], ["large", C.pointMul(C.BASE8, C.randomNonce())],
      ["subgroup-order-minus-one", C.pointMul(C.BASE8, C.SUBGROUP_ORDER - 1n)], ["auditor", auditor.pubKey],
    ].map(([name, [x, y]]) => ({ name, x: s(x), y: s(y) }));
    const invalid = [
      ["identity", [0n, 1n]], ["order2", [0n, C.P - 1n]], ["order4", order4Point()], ["torsion", randomTorsionPoint()],
      ["torsion-2", randomTorsionPoint()], ["off-subgroup", pick()], ["off-subgroup-2", pick()],
      ["off-curve", [1n, 2n]], ["near-generator", [C.BASE8[0] + 1n, C.BASE8[1]]],
      ["x-equals-field", [C.P, C.BASE8[1]]], ["y-above-field", [C.BASE8[0], C.P + 5n]], ["zero", [0n, 0n]],
    ].map(([name, [x, y]]) => ({ name, x: s(x), y: s(y) }));
    for (const v of valid) check(C.isAuditorKey([BigInt(v.x), BigInt(v.y)]), `fixture point ${v.name} is not valid`);
    for (const v of invalid) check(!C.isAuditorKey([BigInt(v.x), BigInt(v.y)]), `fixture point ${v.name} is not invalid`);
    writeFileSync(file("curve-points.json"), JSON.stringify({ valid, invalid }) + "\n");
    console.log("curve-points.json:", valid.length, "valid,", invalid.length, "invalid");
  }

  // ---------------------------------------------------------------- Main storyline
  console.log("main storyline on pool", POOL);
  const out = { chainId: CHAIN_ID, deployer: DEPLOYER, pool: POOL, relayer: RELAYER, withdrawTo: WITHDRAW_TO,
    auditorKey: auditor.pubKey.map(s), nextAuditorKey: nextAuditor.pubKey.map(s),
    auditorSecret: s(auditor.secret), nextAuditorSecret: s(nextAuditor.secret),
    alicePk: s(alice.pk), bobPk: s(bob.pk), emptyRoot: s(new C.Tree().root) };

  const story = new Story(10);
  const g = (n) => BigInt(n) * ETH / 1000n;
  // 1. Alice deposits 0.1 ETH. 2. Alice deposits 0.05 ETH.
  await story.add("a_deposit_1", { privKey: alice.sk, outputs: [note(10, 1, g(100), alice.pk)], ext: { extAmount: g(100) } });
  await story.add("a_deposit_2", { privKey: alice.sk, outputs: [note(10, 2, g(50), alice.pk)], ext: { extAmount: g(50) } });
  // 3. Alice pays Bob 0.07 ETH through the relayer, keeps 0.029, the relayer gets 0.001.
  await story.add("a_pay_bob", { privKey: alice.sk, inputs: [story.noteOf("a_deposit_1")],
    outputs: [note(10, 3, g(70), bob.pk), note(10, 4, g(29), alice.pk)],
    ext: { relayer: RELAYER, fee: g(1), note0: "0x1111", note1: "0x2222" } });
  // 4. Bob withdraws 0.05 ETH directly from his wallet and keeps 0.02.
  await story.add("b_withdraw", { privKey: bob.sk, inputs: [story.noteOf("a_pay_bob", 0)], outputs: [note(10, 5, g(20), bob.pk)],
    ext: { recipient: WITHDRAW_TO, extAmount: -g(50) } });
  const afterFour = story.snapshot();
  // 5. Alice merges her two notes into 0.079. 6. Alice withdraws all of it.
  await story.add("a_merge", { privKey: alice.sk, inputs: [story.noteOf("a_pay_bob", 1), story.noteOf("a_deposit_2")], outputs: [note(10, 6, g(79), alice.pk)] });
  await story.add("a_withdraw", { privKey: alice.sk, inputs: [story.noteOf("a_merge")], ext: { recipient: WITHDRAW_TO, extAmount: -g(79) } });
  out.steps = story.steps;

  // ---- the merge again, on the same tree state, sealed to the next auditor key / made for another chain
  {
    const merge = { privKey: alice.sk, inputs: [story.noteOf("a_pay_bob", 1), story.noteOf("a_deposit_2")], outputs: [note(10, 6, g(79), alice.pk)] };
    for (const [name, auditorPubKey, chainId, tag] of [["a_merge_next_auditor", nextAuditor.pubKey, CHAIN_ID, 500], ["a_merge_other_chain", auditor.pubKey, 4663, 501]]) {
      const tx = await makeTx(restoreTree(afterFour), { ...merge, auditorPubKey, chainId, salt: 10, tag });
      out.steps[name] = tx.step;
      console.log("  proved", name);
    }
    // The first deposit, made for another pool.
    const foreign = getContractAddress({ from: DEPLOYER, nonce: 9 });
    const tx = await makeTx(new C.Tree(), { privKey: alice.sk, outputs: [note(10, 1, g(100), alice.pk)], ext: { extAmount: g(100) }, pool: foreign, salt: 10, tag: 600 });
    out.steps.a_deposit_1_other_pool = tx.step;
    console.log("  proved a_deposit_1_other_pool");
  }

  // ---------------------------------------------------------------- Root-history storyline
  // Three deposits, then the note of the first one spent under each of the three roots.
  console.log("root-history storyline");
  {
    const h = new Story(20);
    const deposit = (i) => h.add(`h_deposit_${i}`, { privKey: alice.sk, outputs: [note(20, i, g(10), alice.pk)], ext: { extAmount: g(10) } });
    out.steps.h_deposit_1 = await deposit(1); const note1 = h.noteOf("h_deposit_1"); const snap1 = h.snapshot();
    out.steps.h_deposit_2 = await deposit(2); const snap2 = h.snapshot();
    out.steps.h_deposit_3 = await deposit(3);
    const spend = { privKey: alice.sk, inputs: [note1], outputs: [note(20, 9, g(10), alice.pk)] };
    for (const [name, snap, tag] of [["h_spend_under_root1", snap1, 700], ["h_spend_under_root2", snap2, 701]]) {
      const tx = await makeTx(restoreTree(snap), { ...spend, salt: 20, tag });
      out.steps[name] = tx.step; console.log("  proved", name);
    }
    const tx = await makeTx(restoreTree(h.snapshot()), { ...spend, salt: 20, tag: 702 });
    out.steps.h_spend_under_root3 = tx.step; console.log("  proved h_spend_under_root3");
    out.history = { root1: snap1.layers.at(-1)[0].toString(), root2: snap2.layers.at(-1)[0].toString(), root3: h.tree.root.toString() };
  }

  out.provingKeySha256 = sha256(ZKEY);
  writeFileSync(file("proofs.json"), JSON.stringify(out) + "\n");
  console.log("proofs.json written");
  stopWorkers();
}

// ---------------------------------------------------------------- Solidity twin of the fixtures
// Reading JSON in a Foundry test costs a few hundred thousand gas per field, because every
// call parses the whole file again. The same data as typed constants costs nothing.
{
  const proofs = JSON.parse(readFileSync(file("proofs.json"), "utf8"));
  const vectors = JSON.parse(readFileSync(file("hasher-vectors.json"), "utf8")).vectors;
  const points = JSON.parse(readFileSync(file("curve-points.json"), "utf8"));
  const tree = JSON.parse(readFileSync(file("tree-vectors.json"), "utf8"));
  const steps = Object.keys(proofs.steps);

  const U = (v) => `uint256(${v})`;
  // A bare address literal; Solidity insists on the EIP-55 checksum.
  const A = (v) => getAddress(v);
  const B = (hex) => `hex"${hex.slice(2)}"`;
  const pair = ([x, y]) => `[${U(x)}, ${U(y)}]`;
  const five = (xs) => `[${xs.map(U).join(", ")}]`;
  const proof = (p) => `Pool.Proof({ a: ${pair(p.a)}, b: [${pair(p.b[0])}, ${pair(p.b[1])}], c: ${pair(p.c)}, root: ${U(p.root)}, nullifiers: ${pair(p.nullifiers)}, commitments: ${pair(p.commitments)}, auditEphemeral: ${pair(p.auditEphemeral)}, auditCipher: ${five(p.auditCipher)} })`;
  const ext = (e) => `Pool.ExtData({ recipient: ${A(e.recipient)}, extAmount: ${e.extAmount}, relayer: ${A(e.relayer)}, fee: ${U(e.fee)}, note0: ${B(e.note0)}, note1: ${B(e.note1)} })`;
  const stepBody = (i) => {
    const name = steps[i], st = proofs.steps[name];
    // Steps that are not part of a committed storyline carry zero where the tree state would be.
    const publicSignals = st.publicSignals ?? Array(16).fill("0");
    return [
      `name: "${name}"`, `proof: ${proof(st.proof)}`, `ext: ${ext(st.ext)}`,
      `publicSignals: [${publicSignals.map((v) => `uint256(${v})`).join(", ")}]`,
      `rootAfter: ${U(st.rootAfter ?? 0)}`, `index: ${pair(st.index ?? [0, 0])}`,
    ].join(",\n            ");
  };
  const stepLines = steps.map((name, i) => `        if (i == ${i}) return Step({\n            ${stepBody(i)}\n        });`).join("\n");
  const indexLines = steps.map((name, i) => `        if (keccak256(bytes(name)) == keccak256("${name}")) return ${i};`).join("\n");

  const sol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Pool} from "../src/Pool.sol";

/// @dev GENERATED FILE by scripts/gen-fixtures.mjs. Do not edit.
///      Real Groth16 proofs made with the proving key whose sha256 is
///      ${proofs.provingKeySha256}
///      for a pool at ${POOL} on chain ${CHAIN_ID}. The Hasher is deployed by the same
///      deployer at nonce 0 and the verifier at nonce 1, so the pool lands at nonce 2.
library FixtureData {
    uint256 internal constant CHAIN_ID = ${CHAIN_ID};
    address internal constant DEPLOYER = address(uint160(0xa11ce));
    address internal constant POOL = ${A(POOL)};
    address internal constant RELAYER = address(uint160(0xbeef));
    address internal constant WITHDRAW_TO = address(uint160(0xcafe));
    uint256 internal constant AUDITOR_X = ${U(proofs.auditorKey[0])};
    uint256 internal constant AUDITOR_Y = ${U(proofs.auditorKey[1])};
    uint256 internal constant NEXT_AUDITOR_X = ${U(proofs.nextAuditorKey[0])};
    uint256 internal constant NEXT_AUDITOR_Y = ${U(proofs.nextAuditorKey[1])};

    function auditorKey() internal pure returns (uint256[2] memory) {
        return [AUDITOR_X, AUDITOR_Y];
    }

    function nextAuditorKey() internal pure returns (uint256[2] memory) {
        return [NEXT_AUDITOR_X, NEXT_AUDITOR_Y];
    }
    uint256 internal constant EMPTY_ROOT = ${U(proofs.emptyRoot)};

    uint256 internal constant STEP_COUNT = ${steps.length};

    /// @notice One proved transaction and everything the pool needs to submit it.
    struct Step {
        string name;
        Pool.Proof proof;
        Pool.ExtData ext;
        uint256[16] publicSignals;
        uint256 rootAfter;
        uint256[2] index;
    }

    /// @notice One transaction of the storylines by index, built from constants on demand.
    function step(uint256 i) internal pure returns (Step memory) {
${stepLines}
        revert("FixtureData: step index out of range");
    }

    /// @notice The index of a transaction by name.
    function stepIndex(string memory name) internal pure returns (uint256) {
${indexLines}
        revert("FixtureData: no such step");
    }

    /// @notice Every transaction of the storylines, in a fixed order.
    function steps() internal pure returns (Step[] memory out) {
        out = new Step[](STEP_COUNT);
        for (uint256 i = 0; i < STEP_COUNT; i++) out[i] = step(i);
    }

    // ---------------------------------------------------------------- Poseidon values from circomlibjs
    struct Vector {
        uint256 a;
        uint256 b;
        uint256 expected;
    }

    function vectors() internal pure returns (Vector[] memory out) {
        out = new Vector[](${vectors.length});
${vectors.map((v, i) => `        out[${i}] = Vector({ a: ${U(v.a)}, b: ${U(v.b)}, expected: ${U(v.expected)} });`).join("\n")}
    }

    // ---------------------------------------------------------------- auditor keys
    uint256 internal constant VALID_KEY_COUNT = ${points.valid.length};
    uint256 internal constant INVALID_KEY_COUNT = ${points.invalid.length};

    /// @notice Points of the prime-order subgroup.
    function validKeys() internal pure returns (uint256[2][${points.valid.length}] memory out) {
        out = [${points.valid.map((v) => `[uint256(${v.x}), uint256(${v.y})]`).join(", ")}];
    }

    /// @notice Identity, torsion points, points outside the subgroup, points off the curve, values outside the field.
    function invalidKeys() internal pure returns (uint256[2][${points.invalid.length}] memory out) {
        out = [${points.invalid.map((v) => `[uint256(${v.x}), uint256(${v.y})]`).join(", ")}];
    }

    // ---------------------------------------------------------------- root-history storyline
    /// @dev Roots after the first, second and third deposit.
    uint256 internal constant HISTORY_ROOT1 = ${U(proofs.history.root1)};
    uint256 internal constant HISTORY_ROOT2 = ${U(proofs.history.root2)};
    uint256 internal constant HISTORY_ROOT3 = ${U(proofs.history.root3)};

    // ---------------------------------------------------------------- known-answer vectors
    /// @dev Ten leaf commitments of a pool that ran this protocol, in leaf order, with the
    ///      root it published after them. Replaying them must give the same roots.
    function treeVectorLeaves() internal pure returns (uint256[${tree.commitments.length}] memory out) {
        out = [${tree.commitments.map((c) => `uint256(${c.commitment})`).join(", ")}];
    }
    uint256 internal constant TREE_VECTOR_LAST_ROOT = ${U(tree.lastRoot)};
}
`;
  writeFileSync(join(ROOT, "test/FixtureData.sol"), sol);
  console.log("written test/FixtureData.sol");
}
process.exit(0);
