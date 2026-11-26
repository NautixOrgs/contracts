// Witness generation and proof generation for the `transact` circuit.
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as snarkjs from "snarkjs";
import { WitnessCalculatorBuilder } from "circom_runtime";

const ROOT = join(import.meta.dirname, "..", "..");
export const BUILD = join(ROOT, "build");
export const WASM = join(BUILD, "zk/transact_js/transact.wasm");
export const R1CS = join(BUILD, "zk/transact.r1cs");
export const ZKEY = join(BUILD, "keys/transact.zkey");
export const VKEY = join(BUILD, "keys/transact_verification_key.json");
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let calculator = null;
/** One wasm instance is reused: loading it is far slower than a witness. */
export async function witnessCalculator() {
  calculator ??= await WitnessCalculatorBuilder(readFileSync(WASM), { logError() {} });
  return calculator;
}

/** The witness as decimal strings, or null when no witness satisfies the circuit. */
export async function witnessOf(signals) {
  try {
    const w = await (await witnessCalculator()).calculateWitness(signals, true);
    return w.map(String);
  } catch {
    return null;
  }
}

/** True when these signals satisfy every constraint of the compiled circuit. */
export async function circuitAccepts(signals) {
  const w = await witnessOf(signals);
  if (!w) return false;
  const dir = mkdtempSync(join(tmpdir(), "shielded-pool-wtns-"));
  try {
    const file = join(dir, "w.wtns");
    // Independent second opinion: check the witness against the r1cs constraints.
    await snarkjs.wtns.calculate(signals, WASM, file);
    return await snarkjs.wtns.check(R1CS, file, quiet);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A Groth16 proof for these signals, made with the proving key in build/keys. */
export async function prove(signals, zkey = ZKEY) {
  if (!existsSync(zkey)) throw new Error(`no proving key at ${zkey}; run node scripts/setup-proving-key.mjs first`);
  return snarkjs.groth16.fullProve(signals, WASM, zkey);
}

/** groth16.prove / fullProve output checked against a verification key. */
export const verify = (proof, publicSignals, vkey = VKEY) =>
  snarkjs.groth16.verify(vkey instanceof Object ? vkey : JSON.parse(readFileSync(vkey, "utf8")), publicSignals, proof);

export const stopWorkers = () => globalThis.curve_bn128?.terminate?.();

/** sha256 of a file, as a hex string. */
export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Runs the snarkjs command line once, in a process of its own, and returns its output. */
export function snarkjsCli(args) {
  const bin = join(ROOT, "node_modules", ".bin", "snarkjs");
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error) throw r.error;
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/**
 * Proof and public signals in the shape the pool contract takes:
 *   Proof { a, b, c, root, nullifiers, commitments, auditEphemeral, auditCipher }
 * `signals` are the circuit inputs the proof was made from.
 */
export function toPoolProof(proof, signals) {
  const s = (v) => BigInt(v).toString();
  return {
    a: proof.pi_a.slice(0, 2).map(s),
    b: [[s(proof.pi_b[0][1]), s(proof.pi_b[0][0])], [s(proof.pi_b[1][1]), s(proof.pi_b[1][0])]],
    c: proof.pi_c.slice(0, 2).map(s),
    root: s(signals.root),
    nullifiers: signals.inputNullifier.map(s),
    commitments: signals.outputCommitment.map(s),
    auditEphemeral: signals.auditEphemeral.map(s),
    auditCipher: signals.auditCipher.map(s),
  };
}
