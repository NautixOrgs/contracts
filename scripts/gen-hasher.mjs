// Generates src/Hasher.sol: Poseidon of two field elements, as Solidity source.
//
//   node scripts/gen-hasher.mjs
//
// The constants are read from the circuit library's own constant file
// (circomlib/circuits/poseidon_constants.circom), the same numbers the circuit
// compiler uses, so the contract and the circuit cannot drift apart. The rounds
// below mirror circomlib's PoseidonEx step by step for t = 3.
//
// The rounds are written out in inline assembly, each constant pushed where it
// is used and nothing copied through memory. A loop-based version in plain
// Solidity measured four times the gas: the compiler moved the constants
// through memory and reached array elements through helper jumps.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SOURCE = join(ROOT, "node_modules/circomlib/circuits/poseidon_constants.circom");
const OUT = join(ROOT, "src/Hasher.sol");
const T = 3; // state width for two inputs
const ROUNDS_F = 8, ROUNDS_P = 57; // circomlib: N_ROUNDS_P[t - 2] = [56, 57, 56, ...]
const FIELD = "21888242871839275222246405745257275088548364400416034343698204186575808495617";

/** Every constant of the `t == T` branch of one constant function, in file order. */
function constants(name) {
  const src = readFileSync(SOURCE, "utf8");
  const start = src.indexOf(`function ${name}(t) {`);
  if (start < 0) throw new Error(`no function ${name} in ${SOURCE}`);
  const next = src.indexOf("\nfunction ", start + 1);
  const body = src.slice(start, next < 0 ? undefined : next);
  const at = body.indexOf(`t==${T})`);
  const end = body.indexOf("} else if (t==", at);
  if (at < 0 || end < 0) throw new Error(`no t==${T} branch in ${name}`);
  return [...body.slice(at, end).matchAll(/0x[0-9a-fA-F]+/g)].map((m) => BigInt(m[0]).toString());
}

const C = constants("POSEIDON_C"), S = constants("POSEIDON_S"), M = constants("POSEIDON_M"), P = constants("POSEIDON_P");
const expected = [T * ROUNDS_F + ROUNDS_P, ROUNDS_P * (T * 2 - 1), T * T, T * T];
if ([C.length, S.length, M.length, P.length].join() !== expected.join()) {
  throw new Error(`unexpected constant counts: C ${C.length}, S ${S.length}, M ${M.length}, P ${P.length}`);
}

const body = [];
const line = (text) => body.push("            " + text);

// A full round: s-box on all three words, add the round constants, mix with a 3x3 matrix.
// Every block keeps at most eight values alive: the EVM has sixteen stack slots.
function fullRound(number, firstConstant, matrix) {
  const word = (i) => (i === 0 ? "s0" : i === 1 ? "s1" : "s2");
  line(`// Full round ${number}: s-box x^5, ark with C[${firstConstant}..${firstConstant + 2}]`);
  for (const i of [0, 1, 2]) {
    line("{");
    line(`    let t := mulmod(${word(i)}, ${word(i)}, f)`);
    line(`    ${word(i)} := addmod(mulmod(mulmod(t, t, f), ${word(i)}, f), ${C[firstConstant + i]}, f)`);
    line("}");
  }
  // out[i] = matrix[0][i] * s0 + matrix[1][i] * s1 + matrix[2][i] * s2, the matrix stored row by row
  line(`// mix: out[i] = matrix[0][i] * s0 + matrix[1][i] * s1 + matrix[2][i] * s2`);
  line("{");
  line("    let n0 := addmod(addmod(mulmod(" + matrix[0] + ", s0, f), mulmod(" + matrix[3] + ", s1, f), f), mulmod(" + matrix[6] + ", s2, f), f)");
  line("    let n1 := addmod(addmod(mulmod(" + matrix[1] + ", s0, f), mulmod(" + matrix[4] + ", s1, f), f), mulmod(" + matrix[7] + ", s2, f), f)");
  line("    s2 := addmod(addmod(mulmod(" + matrix[2] + ", s0, f), mulmod(" + matrix[5] + ", s1, f), f), mulmod(" + matrix[8] + ", s2, f), f)");
  line("    s0 := n0");
  line("    s1 := n1");
  line("}");
  line("");
}

// A partial round: s-box on the first word only, then the optimised sparse mix.
function partialRound(r) {
  const k = 5 * r, c = T * 5 + r;
  line(`// Partial round ${r}: s-box on the first word, ark with C[${c}]`);
  line("{");
  line("    let t := mulmod(s0, s0, f)");
  line(`    let x := addmod(mulmod(mulmod(t, t, f), s0, f), ${C[c]}, f)`);
  line(`    // sparse mix: out0 = S[${k}..${k + 2}] . (x, s1, s2); out[i] = s[i] + x * S[${k + 3}..${k + 4}][i - 1]`);
  line(`    let n0 := addmod(addmod(mulmod(${S[k]}, x, f), mulmod(${S[k + 1]}, s1, f), f), mulmod(${S[k + 2]}, s2, f), f)`);
  line(`    let n1 := addmod(s1, mulmod(x, ${S[k + 3]}, f), f)`);
  line(`    s2 := addmod(s2, mulmod(x, ${S[k + 4]}, f), f)`);
  line("    s0 := n0");
  line("    s1 := n1");
  line("}");
  line("");
}

line("// The field every value is reduced in.");
line(`let f := ${FIELD}`);
line("");
line("// ark[0]: state = (0, in0, in1) + C[0..2]. calldataload(4) and calldataload(36) are the two inputs:");
line("// the selector takes bytes 0..4, then follow the two 32-byte elements.");
line(`let s0 := ${C[0]}`);
line(`let s1 := addmod(calldataload(4), ${C[1]}, f)`);
line(`let s2 := addmod(calldataload(36), ${C[2]}, f)`);
line("");
for (let r = 0; r < 3; r++) fullRound(r + 1, 3 * (r + 1), M);
fullRound(4, 12, P);
for (let r = 0; r < ROUNDS_P; r++) partialRound(r);
for (let r = 0; r < 3; r++) fullRound(5 + r, 72 + 3 * r, M);
line("// Eighth full round: s-box, then only the first column of M is needed: out = (M * state)[0]");
for (const i of [0, 1, 2]) {
  line("{");
  line(`    let t := mulmod(s${i}, s${i}, f)`);
  line(`    s${i} := mulmod(mulmod(t, t, f), s${i}, f)`);
  line("}");
}
line("{");
line(`    let a := mulmod(${M[0]}, s0, f)`);
line(`    let b := mulmod(${M[3]}, s1, f)`);
line(`    let c := mulmod(${M[6]}, s2, f)`);
line("    result := addmod(addmod(a, b, f), c, f)");
line("}");

const circomlib = JSON.parse(readFileSync(join(ROOT, "node_modules/circomlib/package.json"), "utf8")).version;
const sol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Poseidon hash of two field elements
/// @notice GENERATED FILE. Do not edit. Regenerate with \`node scripts/gen-hasher.mjs\`, which reads the
///         constants from the circuit library (circomlib ${circomlib}, poseidon_constants.circom,
///         state width 3). The circuit and this contract therefore hash alike.
/// @dev Mirrors circomlib's PoseidonEx(nInputs = 2, nOuts = 1) round by round: state width 3,
///      8 full rounds, 57 partial rounds in the optimised sparse form, output = (M * state)[0].
///      The rounds are written out in inline assembly so that every constant is pushed where
///      it is used and nothing is copied through memory.
///      poseidon([1, 2]) = 7853200120776062878684798364095072458815029376092732009249414926327459813530.
contract Hasher {
    /// @notice Poseidon(2): the same function as \`Poseidon(2)\` in the circuit.
    /// @return result The hash, a field element. The assembly reads the two inputs from calldata.
    function poseidon(uint256[2] calldata) external pure returns (uint256 result) {
        assembly ("memory-safe") {
${body.join("\n")}
        }
    }
}
`;

writeFileSync(OUT, sol);
console.log(`written ${OUT}: C ${C.length}, S ${S.length}, M ${M.length}, P ${P.length} constants, ${sol.split("\n").length} lines`);
