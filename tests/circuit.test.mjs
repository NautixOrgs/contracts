// Circuit tests: every case builds real circuit inputs and asks whether a
// witness exists that satisfies all constraints. "Refused" means none does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { circuitAccepts, stopWorkers } from "../scripts/lib/witness.mjs";
import { circuitInfo } from "../scripts/lib/circuit-info.mjs";
import { randomCurvePoint, randomTorsionPoint, order4Point } from "./helpers.mjs";
import * as C from "../scripts/lib/protocol.mjs";

const ETH = 10n ** 18n;
const P = C.P;
let auditor, alice, bob, tree, base;
const clone = (s) => structuredClone(s);

before(() => {
  auditor = C.auditorKeyPair();
  alice = { sk: C.randomField() }; alice.pk = C.pubKeyOf(alice.sk);
  bob = { sk: C.randomField() }; bob.pk = C.pubKeyOf(bob.sk);
  tree = new C.Tree();
  base = { tree, auditorPubKey: auditor.pubKey };
});
after(() => stopWorkers());

/** Runs a transaction that must be accepted and adds its notes to the tree. */
async function commit(args) {
  const tx = C.buildTransaction({ ...base, ...args });
  assert.equal(await circuitAccepts(tx.signals), true);
  const index = tx.signals.outputCommitment.map((c) => tree.insert(c));
  return tx.outputs.map((note, i) => ({ note, index: index[i] }));
}

let aliceNote, bobNote, aliceChange;

// ---------------------------------------------------------------- happy paths

test("deposit: 1 ETH enters as a note", async () => {
  [aliceNote] = await commit({ privKey: alice.sk, outputs: [C.newNote(ETH, alice.pk)], publicAmount: ETH });
});

test("deposit: the largest amount a note may carry is accepted", async () => {
  const max = C.AMOUNT_LIMIT - 1n;
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, outputs: [C.newNote(max, alice.pk)], publicAmount: max });
  assert.equal(await circuitAccepts(tx.signals), true);
});

test("transfer: Alice pays Bob 0.7 ETH and keeps 0.3 ETH; the auditor reads it, nobody else can", async () => {
  const outs = [C.newNote(7n * ETH / 10n, bob.pk), C.newNote(3n * ETH / 10n, alice.pk)];
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceNote], outputs: outs });
  assert.equal(await circuitAccepts(tx.signals), true);

  const s = tx.signals;
  const seen = C.auditDecrypt(s.auditCipher, s.auditEphemeral, auditor.secret, s.inputNullifier[0]);
  assert.equal(seen.sender, alice.pk);
  assert.deepEqual(seen.outputs, [{ amount: 7n * ETH / 10n, pubKey: bob.pk }, { amount: 3n * ETH / 10n, pubKey: alice.pk }]);
  const blind = C.auditDecrypt(s.auditCipher, s.auditEphemeral, C.auditorKeyPair().secret, s.inputNullifier[0]);
  assert.notEqual(blind.sender, alice.pk);
  assert.notEqual(blind.outputs[0].amount, 7n * ETH / 10n);

  const idx = s.outputCommitment.map((c) => tree.insert(c));
  bobNote = { note: outs[0], index: idx[0] };
  aliceChange = { note: outs[1], index: idx[1] };
});

test("withdraw: Bob takes 0.5 ETH out, pays a 0.01 ETH relayer fee, keeps the rest", async () => {
  const fee = ETH / 100n, out = ETH / 2n;
  const rest = bobNote.note.amount - out - fee;
  [bobNote] = await commit({ privKey: bob.sk, inputs: [bobNote], outputs: [C.newNote(rest, bob.pk)], publicAmount: -(out + fee) });
});

test("merge: two notes of one owner become one", async () => {
  const [second] = await commit({ privKey: alice.sk, outputs: [C.newNote(2n * ETH, alice.pk)], publicAmount: 2n * ETH });
  const total = aliceChange.note.amount + second.note.amount;
  [aliceChange] = await commit({ privKey: alice.sk, inputs: [aliceChange, second], outputs: [C.newNote(total, alice.pk)] });
});

test("two empty notes in and two empty notes out is a valid (pointless) transaction", async () => {
  const tx = C.buildTransaction({ ...base, privKey: alice.sk });
  assert.equal(await circuitAccepts(tx.signals), true);
});

test("a statement made against an older root stays true once the tree has moved on", async () => {
  const [note] = await commit({ privKey: alice.sk, outputs: [C.newNote(3n * ETH, alice.pk)], publicAmount: 3n * ETH });
  const spendIt = () => C.buildTransaction({ ...base, privKey: alice.sk, inputs: [note], outputs: [C.newNote(3n * ETH, bob.pk)] });
  const older = spendIt().signals; // root and path of the tree as it is right now
  tree.insert(C.randomField()); tree.insert(C.randomField());
  assert.notEqual(tree.root, older.root);
  assert.equal(await circuitAccepts(older), true, "the tree only grows, so the old root still contains the note");
  const mixed = clone(older); mixed.root = tree.root;
  assert.equal(await circuitAccepts(mixed), false, "a path must be presented with the root it was built for");
  assert.equal(await circuitAccepts(spendIt().signals), true, "same note, path rebuilt for the new root");
});

// ------------------------------------------------------------------- attacks

const spend = (extra = {}) => C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange],
  outputs: [C.newNote(aliceChange.note.amount, bob.pk)], ...extra });

test("the base spend used by the attack tests is itself valid", async () => {
  assert.equal(await circuitAccepts(spend().signals), true);
});

test("refused: creating money (outputs worth more than inputs)", async () => {
  const tx = spend({ outputs: [C.newNote(aliceChange.note.amount + 1n, bob.pk)] });
  assert.equal(await circuitAccepts(tx.signals), false);
});

test("refused: destroying money silently (outputs worth less than inputs, public amount 0)", async () => {
  const tx = spend({ outputs: [C.newNote(aliceChange.note.amount - 1n, bob.pk)] });
  assert.equal(await circuitAccepts(tx.signals), false);
});

test("refused: creating money through a field wrap-around", async () => {
  const huge = 1000n * ETH;
  const tx = spend({ outputs: [C.newNote(aliceChange.note.amount + huge, bob.pk), C.newNote(P - huge, alice.pk)] });
  assert.equal(await circuitAccepts(tx.signals), false);
});

test("refused: an output amount at the 2^96 limit", async () => {
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, outputs: [C.newNote(C.AMOUNT_LIMIT, alice.pk)], publicAmount: C.AMOUNT_LIMIT });
  assert.equal(await circuitAccepts(tx.signals), false);
});

test("refused: spending someone else's note, also with the owner rewritten", async () => {
  const tx = C.buildTransaction({ ...base, privKey: bob.sk, inputs: [aliceChange], outputs: [C.newNote(aliceChange.note.amount, bob.pk)] });
  assert.equal(await circuitAccepts(tx.signals), false);
  const relabelled = { note: { ...aliceChange.note, pubKey: bob.pk }, index: aliceChange.index };
  const tx2 = C.buildTransaction({ ...base, privKey: bob.sk, inputs: [relabelled], outputs: [C.newNote(aliceChange.note.amount, bob.pk)] });
  assert.equal(await circuitAccepts(tx2.signals), false);
});

test("refused: mixing notes of two owners under one key", async () => {
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange, bobNote],
    outputs: [C.newNote(aliceChange.note.amount + bobNote.note.amount, alice.pk)] });
  assert.equal(await circuitAccepts(tx.signals), false);
});

test("refused: a note that was never deposited, and the same note declared empty", async () => {
  const fake = { note: C.newNote(5n * ETH, alice.pk), index: aliceChange.index };
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [fake], outputs: [C.newNote(5n * ETH, alice.pk)] });
  assert.equal(await circuitAccepts(tx.signals), false);
  const asEmpty = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [{ ...fake, empty: true }], outputs: [C.newNote(5n * ETH, alice.pk)] });
  assert.equal(await circuitAccepts(asEmpty.signals), false);
});

test("refused: a real note with a larger amount written on it", async () => {
  const inflated = { note: { ...aliceChange.note, amount: aliceChange.note.amount * 2n }, index: aliceChange.index };
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [inflated], outputs: [C.newNote(inflated.note.amount, alice.pk)] });
  assert.equal(await circuitAccepts(tx.signals), false);
});

test("refused: the same note twice in one transaction", async () => {
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange, aliceChange],
    outputs: [C.newNote(aliceChange.note.amount * 2n, alice.pk)] });
  assert.equal(await circuitAccepts(tx.signals), false);
});

test("refused: a root the tree never had", async () => {
  const s = clone(spend().signals); s.root = C.randomField();
  assert.equal(await circuitAccepts(s), false);
});

test("refused: the right note at the wrong position, or with a wrong sibling", async () => {
  const moved = { note: aliceChange.note, index: aliceChange.index - 1 };
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [moved], outputs: [C.newNote(aliceChange.note.amount, bob.pk)] });
  assert.equal(await circuitAccepts(tx.signals), false);
  const s = clone(spend().signals); s.inPathElements[0][3] = C.randomField();
  assert.equal(await circuitAccepts(s), false);
});

test("refused: a nullifier other than the note's own", async () => {
  const s = clone(spend().signals); s.inputNullifier[0] = C.randomField();
  assert.equal(await circuitAccepts(s), false);
  const same = clone(spend().signals); same.inputNullifier[1] = same.inputNullifier[0];
  assert.equal(await circuitAccepts(same), false);
});

test("refused: an output commitment that does not match the note", async () => {
  for (let i = 0; i < 2; i++) {
    const s = clone(spend().signals); s.outputCommitment[i] = C.randomField();
    assert.equal(await circuitAccepts(s), false, `output ${i}`);
  }
});

test("refused: withdrawing more than the proof covers", async () => {
  const tx = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange], outputs: [], publicAmount: -aliceChange.note.amount });
  assert.equal(await circuitAccepts(tx.signals), true);
  const s = clone(tx.signals); s.publicAmount = (P - aliceChange.note.amount - ETH) % P;
  assert.equal(await circuitAccepts(s), false);
});

test("refused: any altered value in the auditor's copy", async () => {
  const good = spend().signals;
  for (let i = 0; i < good.auditCipher.length; i++) {
    const s = clone(good); s.auditCipher[i] = (s.auditCipher[i] + 1n) % P;
    assert.equal(await circuitAccepts(s), false, `cipher ${i}`);
  }
  for (const ephemeral of [[1n, 2n], C.auditorKeyPair().pubKey, [0n, 1n]]) {
    const s = clone(good); s.auditEphemeral = ephemeral;
    assert.equal(await circuitAccepts(s), false, `ephemeral ${ephemeral}`);
  }
});

test("refused: telling the auditor a different story than the transaction", async () => {
  const s = clone(spend().signals);
  const lie = C.auditEncrypt([alice.pk, 0n, alice.pk, 0n, alice.pk], auditor.pubKey, s.inputNullifier[0], s.auditNonce);
  s.auditCipher = lie.cipher; s.auditEphemeral = lie.ephemeral;
  assert.equal(await circuitAccepts(s), false);
  // A truthful record for a different transaction does not fit either.
  const other = C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange], outputs: [C.newNote(1n, bob.pk)] });
  s.auditCipher = clone(other.signals.auditCipher); s.auditEphemeral = clone(other.signals.auditEphemeral);
  assert.equal(await circuitAccepts(s), false);
});

test("refused: a copy sealed to one key but presented as sealed to another", async () => {
  const s = clone(spend().signals); s.auditorPubKey = C.auditorKeyPair().pubKey;
  assert.equal(await circuitAccepts(s), false);
});

test("refused: an auditor key that is not a point on the curve", async () => {
  const s = clone(spend().signals); s.auditorPubKey = [1n, 2n];
  assert.equal(await circuitAccepts(s), false);
  const s2 = clone(spend().signals); s2.auditorPubKey = [C.BASE8[0] + 1n, C.BASE8[1]];
  assert.equal(await circuitAccepts(s2), false);
});

test("refused: an audit nonce that does not fit 251 bits, or does not match the ephemeral point", async () => {
  const s = clone(spend().signals); s.auditNonce = 1n << 251n;
  assert.equal(await circuitAccepts(s), false);
  const s2 = clone(spend().signals); s2.auditNonce = (s2.auditNonce + 1n) % (1n << 251n);
  assert.equal(await circuitAccepts(s2), false);
});

test("every public signal is used by at least one constraint, and no wire is left dangling", async () => {
  // extDataHash is the one to watch: a public input that no constraint mentions would not be
  // bound by the circuit. (The proof system binds every public input anyway; this keeps the
  // circuit honest on its own.)
  const info = circuitInfo();
  assert.equal(info.nPublic, 16);
  for (const s of info.publicSignals) assert.ok(s.constraints > 0, `${s.label} is not constrained`);
  assert.deepEqual(info.unusedWires, []);
});

test("extDataHash is a free value as far as the circuit is concerned: the contract fixes it", async () => {
  const tx = spend();
  for (const h of [0n, C.randomField(), P - 1n]) {
    const s = clone(tx.signals); s.extDataHash = h;
    assert.equal(await circuitAccepts(s), true, "any hash is a legal public statement");
  }
});

// ---------------------------------------------------- where the circuit needs the contract

test("the circuit alone does not refuse an auditor key outside the prime-order subgroup: the contract does", async () => {
  // circomlib's EscalarMulAny documents that it assumes a subgroup point. Whatever the circuit does with
  // other points, the contract test (Pool.t.sol) refuses them all.
  const build = (auditorPubKey) => C.buildTransaction({ ...base, privKey: alice.sk, inputs: [aliceChange],
    outputs: [C.newNote(aliceChange.note.amount, bob.pk)], auditorPubKey }).signals;
  assert.equal(await circuitAccepts(build(C.BASE8)), true, "a subgroup point is fine");
  const outcomes = {
    identity: await circuitAccepts(build([0n, 1n])),
    order2: await circuitAccepts(build([0n, P - 1n])),
    order4: await circuitAccepts(build(order4Point())),
    torsion: await circuitAccepts(build(randomTorsionPoint())),
    offSubgroup: await circuitAccepts(build(randomCurvePoint())),
  };
  console.log("    circuit accepts auditor keys:", JSON.stringify(outcomes, (_, v) => typeof v === "bigint" ? undefined : v));
  // With the identity the shared point is the identity, so the keystream is public. That is the reason
  // the contract, not the circuit, must refuse these keys.
  if (outcomes.identity) {
    const s = build([0n, 1n]);
    const plain = plainOf(s);
    const publicKeystream = plain.map((v, i) => s.auditCipher[i] === (v + C.H(3n, 0n, s.inputNullifier[0], BigInt(i))) % P);
    assert.deepEqual(publicKeystream, [true, true, true, true, true]);
  }
});
function plainOf(s) { return [C.pubKeyOf(s.privKey), s.outAmount[0], s.outPubKey[0], s.outAmount[1], s.outPubKey[1]]; }
