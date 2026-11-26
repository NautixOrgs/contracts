// Protocol mathematics, checked against independent references:
// circomlibjs (the wasm Poseidon) and known-answer vectors recorded from a pool that ran the protocol.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import * as C from "../scripts/lib/protocol.mjs";
import { randomCurvePoint, order4Point } from "./helpers.mjs";

const P = C.P;

const here = dirname(fileURLToPath(import.meta.url));
after(() => globalThis.curve_bn128?.terminate?.());

test("field constants", () => {
  assert.equal(P.toString(), "21888242871839275222246405745257275088548364400416034343698204186575808495617");
  assert.equal(C.AMOUNT_LIMIT, 1n << 96n);
  assert.equal(C.SUBGROUP_ORDER * 8n > P, true, "curve order = 8 * subgroup order, within Hasse's bound of the field size");
  assert.ok(C.SUBGROUP_ORDER * 8n - P < 2n * 10n ** 38n);
});

test("Poseidon agrees with circomlibjs (the wasm reference) for 1, 2 and 4 inputs", async () => {
  const poseidon = await buildPoseidon(), F = poseidon.F;
  for (const n of [1, 2, 4]) {
    for (let i = 0; i < 25; i++) {
      const xs = Array.from({ length: n }, () => C.randomField());
      assert.equal(C.H(...xs).toString(), F.toString(poseidon(xs)), `arity ${n}`);
    }
    const edge = [0n, 1n, P - 1n, P - 2n, C.AMOUNT_LIMIT - 1n].slice(0, n);
    assert.equal(C.H(...edge).toString(), F.toString(poseidon(edge)), `arity ${n}, edge values`);
  }
  // The hash does not range-check: an amount of 2^96 or more is just another
  // field element. The circuit's Num2Bits is what refuses such amounts.
  assert.notEqual(C.H(C.AMOUNT_LIMIT + 5n), C.H(5n));
});

test("the tree reproduces the roots of its known-answer vectors", () => {
  const fx = JSON.parse(readFileSync(join(here, "../test/fixtures/tree-vectors.json"), "utf8"));
  const tree = new C.Tree(fx.levels);
  assert.equal(tree.root.toString(), fx.emptyRoot, "empty root");
  for (const c of fx.commitments) assert.equal(tree.insert(BigInt(c.commitment)), c.index);
  assert.equal(tree.root.toString(), fx.lastRoot, "root after replaying every committed note");
  assert.equal(tree.size, fx.commitments.length);
  // Every Merkle path out of this tree walks back to the same root.
  for (let i = 0; i < tree.size; i++) {
    let cur = tree.layers[0][i], at = i;
    for (const sib of tree.path(i)) {
      cur = C.H(...(at % 2 === 0 ? [cur, sib] : [sib, cur]));
      at = Math.floor(at / 2);
    }
    assert.equal(cur.toString(), fx.lastRoot, `path of leaf ${i}`);
  }
});

test("BabyJubJub: the generator is on the curve and in the prime-order subgroup", () => {
  assert.ok(C.onCurve(C.BASE8) && !C.isIdentity(C.BASE8) && C.inSubgroup(C.BASE8));
  for (const k of [2n, 3n, 1000n, C.SUBGROUP_ORDER - 1n, C.randomNonce()]) {
    const p = C.pointMul(C.BASE8, k);
    assert.ok(C.onCurve(p) && !C.isIdentity(p) && C.inSubgroup(p), `k = ${k}`);
  }
  // The subgroup has prime order, so r_s * G is the identity.
  assert.ok(C.isIdentity(C.pointMul(C.BASE8, C.SUBGROUP_ORDER)));
  // Scalar multiplication is a homomorphism: (a + b) G = aG + bG.
  const a = C.randomNonce(), b = C.randomNonce();
  const left = C.pointMul(C.BASE8, a + b), right = C.pointAdd(C.pointMul(C.BASE8, a), C.pointMul(C.BASE8, b));
  assert.deepEqual(left, right);
});

test("BabyJubJub: most curve points lie outside the subgroup, and torsion points never belong to it", () => {
  let outside = 0;
  for (let i = 0; i < 24; i++) {
    const r = randomCurvePoint();
    assert.ok(C.onCurve(r) && !C.isIdentity(r));
    const inSub = C.isIdentity(C.pointMul(r, C.SUBGROUP_ORDER));
    assert.equal(C.inSubgroup(r), inSub, "inSubgroup is exactly: subgroup order times the point is the identity");
    if (!inSub) {
      outside++;
      // subgroup order * R keeps only the torsion part: a non-identity point that no honest key should be.
      const torsion = C.pointMul(r, C.SUBGROUP_ORDER);
      assert.ok(C.onCurve(torsion) && !C.isIdentity(torsion) && !C.inSubgroup(torsion) && !C.isAuditorKey(torsion));
    }
  }
  assert.ok(outside >= 12, `expected most random curve points outside the subgroup, saw ${outside}/24`);
  // (0, -1) has order 2: on the curve, not the identity, outside the subgroup.
  const order2 = [0n, P - 1n];
  assert.ok(C.onCurve(order2) && !C.isIdentity(order2) && !C.inSubgroup(order2) && !C.isAuditorKey(order2));
  // The identity passes the curve equation and every subgroup test; only the identity check refuses it.
  assert.ok(C.onCurve([0n, 1n]) && C.inSubgroup([0n, 1n]) && !C.isAuditorKey([0n, 1n]));
});

test("random pairs are not on the curve", () => {
  for (let i = 0; i < 20; i++) assert.equal(C.onCurve([C.randomField(), C.randomField()]), false);
  // (0, 1) and (0, -1) are the only curve points with x = 0.
  assert.equal(C.onCurve([0n, 2n]), false);
});

test("auditor record: the auditor reads it, another key does not, and a reused nonce never repeats a keystream", () => {
  const auditor = C.auditorKeyPair(), stranger = C.auditorKeyPair();
  const plain = Array.from({ length: 5 }, () => C.randomField());
  const nonce = C.randomNonce();
  const a = C.auditEncrypt(plain, auditor.pubKey, 111n, nonce);
  const b = C.auditEncrypt(plain, auditor.pubKey, 222n, nonce); // same nonce, another transaction
  assert.deepEqual(a.ephemeral, b.ephemeral);
  assert.notDeepEqual(a.cipher, b.cipher);

  const seen = C.auditDecrypt(a.cipher, a.ephemeral, auditor.secret, 111n);
  assert.deepEqual([seen.sender, ...seen.outputs.flatMap((o) => [o.amount, o.pubKey])], plain);
  assert.notEqual(C.auditDecrypt(a.cipher, a.ephemeral, stranger.secret, 111n).sender, plain[0]);
  assert.notEqual(C.auditDecrypt(a.cipher, a.ephemeral, auditor.secret, 111n + 1n).sender, plain[0]);
});
