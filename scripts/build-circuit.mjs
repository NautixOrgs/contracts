// Compiles circuits/transact.circom into build/zk (r1cs, wasm witness calculator, sym).
//
//   node scripts/build-circuit.mjs
//
// Uses .tools/bin/circom when it is there, otherwise whatever `circom` is on PATH.
// To install the compiler into .tools:
//   cargo install circom --git https://github.com/iden3/circom.git --tag v2.2.3 --root .tools --locked
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD = join(ROOT, "build/zk");
const local = join(ROOT, ".tools/bin/circom");
const circom = existsSync(local) ? local : "circom";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(BUILD, { recursive: true });
  execFileSync(circom, ["circuits/transact.circom", "--r1cs", "--wasm", "--sym", "-o", BUILD, "-l", join(ROOT, "node_modules")],
    { cwd: ROOT, stdio: "inherit" });
}
