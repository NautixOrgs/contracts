// Makes the proving key of the `transact` circuit and exports what the chain
// needs to check proofs.
//
//   node scripts/setup-proving-key.mjs --network testnet|mainnet   the beacon is a block of that chain
//   node scripts/setup-proving-key.mjs --network local             the beacon is random bytes; development only
//
// Phase 1 is the public Hermez powers-of-tau ceremony, with many independent
// participants; the file is checked against the checksum published by snarkjs.
// Phase 2 is specific to this circuit and has two steps:
//   1. one contribution with 64 random bytes from this machine's operating
//      system, used once and never written anywhere;
//   2. a beacon: the hash of a block of the target chain mined after step 1
//      finished, so nobody, including whoever ran step 1, could have chosen it.
//
// The key is sound unless the single contributor of step 1 kept their
// randomness. That cannot be proved to outsiders. Before holding real money,
// add more contributors between step 1 and the beacon.
//
// Writes build/keys/transact.zkey, build/keys/transact_verification_key.json,
// src/Verifier.sol and ceremony/<network>.json (the public record).
import * as snarkjs from "snarkjs";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { circuitInfo } from "./lib/circuit-info.mjs";
import { R1CS, ZKEY, VKEY, WASM, prove, verify, sha256, snarkjsCli, stopWorkers } from "./lib/witness.mjs";
import * as C from "./lib/protocol.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NETWORKS = {
  testnet: { chainId: 46630, name: "Robinhood Chain Testnet", rpc: "https://rpc.testnet.chain.robinhood.com" },
  mainnet: { chainId: 4663, name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com" },
  // No chain to beacon from: the beacon is random bytes from this machine. Fine for development only.
  local: null,
};
const PHASE1 = {
  file: "powersOfTau28_hez_final_16.ptau",
  url: "https://circom.info/powersOfTau28_hez_final_16.ptau",
  // Published in the snarkjs README (iden3/snarkjs), trusted setup section.
  blake2b512: "6a6277a2f74e1073601b4f9fed6e1e55226917efb0f0db8a07d98ab01df1ccf43eb0e8c3159432acd4960e2f29fe84a4198501fa54c8dad9e43297453efec125",
};
const BEACON_ITERATIONS_EXP = 10;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const say = (m) => console.log(m);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[++i];
}
const network = args.network ?? "testnet";
if (!(network in NETWORKS)) { console.error("usage: node scripts/setup-proving-key.mjs --network testnet|mainnet|local"); process.exit(1); }
const net = NETWORKS[network];
const ptau = join(ROOT, "build/ptau", PHASE1.file);
const KEYS = dirname(ZKEY);
const z0 = join(KEYS, "transact_0000.zkey"), z1 = join(KEYS, "transact_0001.zkey");
const recordFile = join(ROOT, "ceremony", `${network}.json`);

const digest = (file, algo) => new Promise((ok, no) => {
  const h = createHash(algo);
  createReadStream(file).on("data", (b) => h.update(b)).on("end", () => ok(h.digest("hex"))).on("error", no);
});
/** A JSON-RPC call. A block that is not mined yet answers null, which is not an error. */
const rpc = async (method, params) => {
  const r = await fetch(net.rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const out = await r.json();
  if (out.error) throw new Error(`${method}: ${JSON.stringify(out.error)}`);
  return out.result ?? null;
};
const step = (m) => say("  " + m);

if (existsSync(recordFile)) { console.error(`ceremony/${network}.json already exists. Remove it to make a new key (that also means a new verifier and a new pool).`); process.exit(1); }
mkdirSync(KEYS, { recursive: true });
mkdirSync(join(ROOT, "ceremony"), { recursive: true });
if (!existsSync(R1CS)) { console.error("compile the circuit first: node scripts/build-circuit.mjs"); process.exit(1); }

// ---------------------------------------------------------------- phase 1
if (!existsSync(ptau)) {
  say(`downloading ${PHASE1.url}`);
  const r = await fetch(PHASE1.url);
  if (!r.ok) { console.error("download failed: " + r.status); process.exit(1); }
  await pipeline(Readable.fromWeb(r.body), createWriteStream(ptau));
}
say("checking the phase-1 file against the published checksum");
if ((await digest(ptau, "blake2b512")) !== PHASE1.blake2b512) { console.error("the phase-1 file does not match the published checksum"); process.exit(1); }

const circuit = circuitInfo();
say(`circuit ${circuit.template}: ${circuit.nConstraints} constraints, sha256 ${circuit.r1csSha256}`);

// ---------------------------------------------------------------- phase 2
await snarkjs.zKey.newZKey(R1CS, ptau, z0, quiet);
step("circuit key started from phase 1");

const contribution = Buffer.from(await snarkjs.zKey.contribute(z0, z1, "shielded-pool setup", randomBytes(64).toString("hex"))).toString("hex");
step("contribution made (randomness used once, not stored)");
const keyAfterContribution = await digest(z1, "sha256");

let beacon, beaconBlock = null;
if (net) {
  // The block is chosen only now, after the contribution is fixed on disk.
  const ahead = Number(args.ahead ?? 20);
  beaconBlock = BigInt(await rpc("eth_blockNumber", [])) + BigInt(ahead);
  step(`waiting for block ${beaconBlock} (${ahead} blocks ahead)`);
  let block = null;
  while (!block) {
    block = await rpc("eth_getBlockByNumber", ["0x" + beaconBlock.toString(16), false]);
    if (!block) await new Promise((r) => setTimeout(r, 400));
  }
  beacon = block.hash.slice(2);
  step(`beacon: block ${beaconBlock}, hash ${block.hash}`);
} else {
  beacon = randomBytes(32).toString("hex");
  step("beacon: random bytes from this machine (local key only)");
}
await snarkjs.zKey.beacon(z1, ZKEY, beaconBlock === null ? "local beacon" : `${net.name} block ${beaconBlock}`, beacon, BEACON_ITERATIONS_EXP);

// ---------------------------------------------------------------- checks
// Returns a plain boolean, unlike what the name suggests.
const mine = await snarkjs.zKey.verifyFromR1cs(R1CS, ptau, ZKEY, quiet);
if (mine !== true) { console.error("the finished key does not verify against the circuit and phase 1"); process.exit(1); }
const theirs = snarkjsCli(["zkey", "verify", R1CS, ptau, ZKEY]);
if (theirs.status !== 0 || !theirs.out.includes("ZKey Ok!")) { console.error("snarkjs zkey verify disagrees:\n" + theirs.out); process.exit(1); }
step("key verified against circuit and phase 1 (in this process and by the snarkjs command line)");

const vkey = await snarkjs.zKey.exportVerificationKey(ZKEY, quiet);
writeFileSync(VKEY, JSON.stringify(vkey, null, 2) + "\n");

const template = readFileSync(join(ROOT, "node_modules/snarkjs/templates/verifier_groth16.sol.ejs"), "utf8");
const sol = await snarkjs.zKey.exportSolidityVerifier(ZKEY, { groth16: template });
const finalKeySha256 = await digest(ZKEY, "sha256");
const verifierFile = join(ROOT, "src/Verifier.sol");
writeFileSync(verifierFile,
  `// GENERATED FILE. Do not edit. Made by scripts/setup-proving-key.mjs from build/keys/transact.zkey\n` +
  `// (sha256 ${finalKeySha256}). The public record of the key is ceremony/${network}.json.\n` + sol);
step(`wrote src/Verifier.sol and build/keys/transact_verification_key.json`);

// ---------------------------------------------------------------- smoke test
{
  const auditor = C.auditorKeyPair(), alice = { sk: C.randomField() };
  alice.pk = C.pubKeyOf(alice.sk);
  const tx = C.buildTransaction({ tree: new C.Tree(), auditorPubKey: auditor.pubKey, privKey: alice.sk,
    outputs: [C.newNote(10n ** 18n, alice.pk)], publicAmount: 10n ** 18n });
  const t0 = performance.now();
  const { proof, publicSignals } = await prove(tx.signals);
  const ms = Math.round(performance.now() - t0);
  if (!(await verify(proof, publicSignals))) { console.error("a proof made with the new key does not verify"); process.exit(1); }
  const tampered = [...publicSignals]; tampered[1] = ((BigInt(tampered[1]) + 1n) % C.P).toString();
  if (await verify(proof, tampered)) { console.error("the key accepts a changed public signal"); process.exit(1); }
  step(`a proof verifies in ${(ms / 1000).toFixed(1)} s and fails once a public signal is changed`);
}

const record = {
  network, chainId: net?.chainId ?? null,
  purpose: net ? "Proving key of the transact circuit" : "Local development key. Never deploy a pool with it.",
  caveat: "Phase 2 had one contributor. The key is sound unless that contributor kept their randomness, which cannot be proved to outsiders.",
  circuit,
  phase1: { file: PHASE1.file, source: PHASE1.url, blake2b512: PHASE1.blake2b512 },
  phase2: [
    { step: 1, kind: "contribution", name: "shielded-pool setup", contributionHash: contribution, keyAfterSha256: keyAfterContribution },
    net
      ? { step: 2, kind: "beacon", chainId: net.chainId, block: beaconBlock.toString(), blockHash: "0x" + beacon, iterationsExp: BEACON_ITERATIONS_EXP,
          note: "block number fixed after step 1 was written to disk, 20 blocks ahead of the head at that moment" }
      : { step: 2, kind: "beacon", source: "operating system randomness of this machine", iterationsExp: BEACON_ITERATIONS_EXP },
  ],
  finalKeySha256,
  verificationKey: vkey,
  verifierSha256: sha256(verifierFile),
  check: "node node_modules/snarkjs/cli.js zkey verify build/zk/transact.r1cs build/ptau/" + PHASE1.file + " build/keys/transact.zkey",
};
writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
say(`written ${recordFile}`);
stopWorkers();
process.exit(0);
