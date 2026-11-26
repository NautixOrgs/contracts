// Client-side mathematics of the shielded pool protocol: keys, notes, the
// commitment tree, the auditor's copy, and the inputs the `transact` circuit
// expects. No network and no storage.
//
// Plain BigInt only, so the same file runs in Node and in a browser.
//
//   note       = (amount, owner public key, blinding)
//   public key = Poseidon(private key)
//   commitment = Poseidon(TAG_NOTE, amount, pubKey, blinding)
//   nullifier  = Poseidon(TAG_NULLIFIER, commitment, leaf index, private key)
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon4 } from "poseidon-lite/poseidon4";

export const LEVELS = 24;
/**
 * The field the circuit works in (the scalar field of BN254). Every Poseidon
 * hash runs in it, and so does the BabyJubJub curve: its coordinates are
 * native circuit elements.
 */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** Order of the prime-order subgroup of BabyJubJub (the curve has cofactor 8). */
export const SUBGROUP_ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
/** Largest amount a single note may carry. */
export const AMOUNT_LIMIT = 1n << 96n;
/** The audit nonce is 251 bits, safely below the subgroup order. */
export const NONCE_BITS = 251n;
/** Number of words in one auditor record. */
export const AUDIT_WORDS = 5;

const TAG_NOTE = 1n, TAG_NULLIFIER = 2n, TAG_AUDIT = 3n;
const POSEIDON = { 1: poseidon1, 2: poseidon2, 4: poseidon4 };

/** Poseidon as the circuit computes it, for 1, 2 or 4 inputs. */
export const H = (...xs) => {
  const f = POSEIDON[xs.length];
  if (!f) throw new Error(`Poseidon is only wired up for 1, 2 or 4 inputs, not ${xs.length}`);
  return f(xs);
};

function randomBigInt(bytes) {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}
/** A uniformly random field element (256 random bits reduced by Poseidon on use). */
export const randomField = () => randomBigInt(31);
export const randomNonce = () => randomBigInt(32) % (1n << NONCE_BITS);

// ---- BabyJubJub: a*x^2 + y^2 = 1 + d*x^2*y^2 over P, a square a and a non-square d,
// ---- so the addition law below is complete on the curve.
const A = 168700n, D = 168696n;
/** Generator of the prime-order subgroup, in twisted Edwards coordinates. */
export const BASE8 = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
];
const IDENTITY = [0n, 1n];
const mod = (v) => ((v % P) + P) % P;
function powMod(b, e) {
  let r = 1n;
  b = mod(b);
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
}
const inv = (v) => powMod(v, P - 2n);

export function pointAdd([x1, y1], [x2, y2]) {
  const k = mod((D * x1 % P) * x2 % P * y1 % P * y2 % P);
  return [mod((x1 * y2 + y1 * x2) * inv(1n + k)), mod((y1 * y2 - A * x1 * x2) * inv(1n - k))];
}
export function pointMul(point, scalar) {
  let acc = IDENTITY, cur = point;
  for (let e = scalar; e > 0n; e >>= 1n) {
    if (e & 1n) acc = pointAdd(acc, cur);
    cur = pointAdd(cur, cur);
  }
  return acc;
}
/** Satisfies the curve equation. The identity (0, 1) and the order-2 point (0, -1) pass too. */
export function onCurve([x, y]) {
  if (x >= P || y >= P) return false;
  const x2 = x * x % P, y2 = y * y % P;
  return mod(A * x2 + y2) === mod(1n + (D * x2 % P) * y2 % P);
}
/** The neutral element (0, 1). The only other point with x = 0 is the order-2 point (0, -1). */
export const isIdentity = ([x, y]) => x === 0n && y === 1n;
/** A usable auditor key: a non-identity point of the prime-order subgroup. */
export function isAuditorKey(point) {
  return onCurve(point) && !isIdentity(point) && inSubgroup(point);
}
/** True for a point of the prime-order subgroup: the only kind the circuit's scalar multiplication accepts. */
export function inSubgroup(point) {
  return isIdentity(pointMul(point, SUBGROUP_ORDER));
}

// ---- notes ----
export const pubKeyOf = (privKey) => H(privKey);
export const commitmentOf = (note) => H(TAG_NOTE, note.amount, note.pubKey, note.blinding);
export const nullifierOf = (commitment, index, privKey) => H(TAG_NULLIFIER, commitment, BigInt(index), privKey);
export const newNote = (amount, pubKey, blinding = randomField()) => ({ amount: BigInt(amount), pubKey, blinding });

/** Incremental Merkle tree: empty leaf 0, Poseidon node hash, same shape as the contract's. */
export class Tree {
  constructor(levels = LEVELS) {
    this.levels = levels;
    this.zeros = [0n];
    for (let i = 0; i < levels; i++) this.zeros.push(H(this.zeros[i], this.zeros[i]));
    this.layers = Array.from({ length: levels + 1 }, () => []);
  }
  get size() { return this.layers[0].length; }
  get root() { return this.layers[this.levels][0] ?? this.zeros[this.levels]; }
  insert(leaf) {
    let index = this.layers[0].length;
    const at = index;
    this.layers[0].push(leaf);
    for (let l = 0; l < this.levels; l++) {
      const left = index % 2 === 0 ? this.layers[l][index] : this.layers[l][index - 1];
      const right = index % 2 === 0 ? (this.layers[l][index + 1] ?? this.zeros[l]) : this.layers[l][index];
      index = Math.floor(index / 2);
      this.layers[l + 1][index] = H(left, right);
    }
    return at;
  }
  /** Sibling on every level for the leaf at `index`. */
  path(index) {
    const out = [];
    for (let l = 0; l < this.levels; l++) {
      const sib = index % 2 === 0 ? index + 1 : index - 1;
      out.push(this.layers[l][sib] ?? this.zeros[l]);
      index = Math.floor(index / 2);
    }
    return out;
  }
}

// ---- auditor ----
export function auditorKeyPair(secret = randomNonce()) {
  return { secret, pubKey: pointMul(BASE8, secret) };
}
const keystream = (sharedX, nullifier0, n) => Array.from({ length: n }, (_, i) => H(TAG_AUDIT, sharedX, nullifier0, BigInt(i)));

/**
 * Seals `plain` to the auditor. Returns what the circuit constrains: the
 * published point R = nonce * BASE8 and the masked words.
 */
export function auditEncrypt(plain, auditorPubKey, nullifier0, nonce = randomNonce()) {
  const ephemeral = pointMul(BASE8, nonce);
  const shared = pointMul(auditorPubKey, nonce);
  const ks = keystream(shared[0], nullifier0, plain.length);
  return { nonce, ephemeral, cipher: plain.map((v, i) => (v + ks[i]) % P) };
}
/** Opens one record. `nullifier0` is public: the first nullifier of that transaction. */
export function auditDecrypt(cipher, ephemeral, auditorSecret, nullifier0) {
  const shared = pointMul(ephemeral, auditorSecret);
  const ks = keystream(shared[0], nullifier0, cipher.length);
  const v = cipher.map((c, i) => (c - ks[i] + P) % P);
  return { sender: v[0], outputs: [{ amount: v[1], pubKey: v[2] }, { amount: v[3], pubKey: v[4] }] };
}

/**
 * Circuit inputs for one transaction.
 *   inputs:  up to 2 of { note, index }, already in `tree`; missing ones are empty notes
 *   outputs: up to 2 notes; missing ones are empty notes to the sender
 *   publicAmount: deposit - withdrawal - fee, as a signed BigInt
 */
export function buildTransaction({ tree, privKey, inputs = [], outputs = [], publicAmount = 0n, extDataHash = 0n, auditorPubKey, auditNonce }) {
  const pubKey = pubKeyOf(privKey);
  const ins = [...inputs];
  while (ins.length < 2) ins.push({ note: newNote(0n, pubKey), index: 0, empty: true });
  const outs = [...outputs];
  while (outs.length < 2) outs.push(newNote(0n, pubKey));

  const inCommit = ins.map((i) => commitmentOf(i.note));
  const inputNullifier = ins.map((_, k) => nullifierOf(inCommit[k], ins[k].index, privKey));
  const outputCommitment = outs.map(commitmentOf);
  const audit = auditEncrypt(
    [pubKey, outs[0].amount, outs[0].pubKey, outs[1].amount, outs[1].pubKey],
    auditorPubKey, inputNullifier[0], auditNonce);

  const noPath = Array(tree.levels).fill(0n);
  return {
    outputs: outs,
    signals: {
      root: tree.root,
      publicAmount: ((BigInt(publicAmount) % P) + P) % P,
      extDataHash,
      inputNullifier,
      outputCommitment,
      auditorPubKey,
      auditEphemeral: audit.ephemeral,
      auditCipher: audit.cipher,
      privKey,
      inAmount: ins.map((i) => i.note.amount),
      inBlinding: ins.map((i) => i.note.blinding),
      inPathIndex: ins.map((i) => BigInt(i.index)),
      inPathElements: ins.map((i) => (i.empty ? noPath : tree.path(i.index))),
      outAmount: outs.map((o) => o.amount),
      outPubKey: outs.map((o) => o.pubKey),
      outBlinding: outs.map((o) => o.blinding),
      auditNonce: audit.nonce,
    },
  };
}

/** Public signals in the order the pool hands them to the verifier. */
export function publicSignals(s) {
  return [s.root, s.publicAmount, s.extDataHash, ...s.inputNullifier, ...s.outputCommitment,
    ...s.auditorPubKey, ...s.auditEphemeral, ...s.auditCipher].map(String);
}
