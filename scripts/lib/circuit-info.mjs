// Static facts about the compiled circuit: sizes, hashes, and which signals
// the constraints actually use. Feeds the ceremony record and the docs, and
// backs a test that no public signal is left unconstrained.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256, snarkjsCli, R1CS, WASM, BUILD } from "./witness.mjs";

const SYM = join(BUILD, "zk/transact.sym");
const JSON_OUT = join(BUILD, "zk/transact.r1cs.json");

/** wire index -> label, from the symbol file the compiler writes. */
function readSymbols() {
  const out = new Map();
  for (const line of readFileSync(SYM, "utf8").split("\n")) {
    const [wire, , , label] = line.trim().split(",");
    if (wire && label) out.set(Number(wire), label);
  }
  return out;
}

export function circuitInfo() {
  const r = snarkjsCli(["r1cs", "export", "json", R1CS, JSON_OUT]);
  if (r.status !== 0) throw new Error("snarkjs r1cs export failed: " + r.out);
  const r1cs = JSON.parse(readFileSync(JSON_OUT, "utf8"));
  const labels = readSymbols();

  const mentions = new Map(); // wire -> number of constraints it appears in
  for (const [A, B, C] of r1cs.constraints) {
    const wires = new Set();
    // Each side of a constraint is { wire index: coefficient, ... }.
    for (const lc of [A, B, C]) for (const w of Object.keys(lc)) wires.add(Number(w));
    for (const w of wires) mentions.set(w, (mentions.get(w) ?? 0) + 1);
  }
  // Wire 0 is the constant 1; the public inputs follow as wires 1..nPubInputs.
  const publicSignals = Array.from({ length: r1cs.nPubInputs }, (_, i) => i + 1).map((w) => ({
    index: w - 1, label: labels.get(w) ?? `wire ${w}`, constraints: mentions.get(w) ?? 0,
  }));
  const unused = [];
  for (let w = 1; w < r1cs.nVars; w++) if (!mentions.has(w)) unused.push(labels.get(w) ?? `wire ${w}`);

  return {
    template: "Transact(24)",
    nConstraints: r1cs.nConstraints,
    nVars: r1cs.nVars,
    nPublic: r1cs.nPubInputs,
    nPrivate: r1cs.nPrvInputs,
    nLabels: r1cs.nLabels,
    useCustomGates: !!r1cs.useCustomGates,
    r1csSha256: sha256(R1CS),
    wasmSha256: sha256(WASM),
    publicSignals,
    unusedWires: unused,
  };
}
