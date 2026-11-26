// Makes the auditor key pair of a pool and stores it in ceremony/<network>-auditor-key.json.
//
//   node scripts/gen-auditor-key.mjs --network <network>
//
// The file holds the secret and the public key. Only the public half goes into the pool. The
// file is never committed: whoever knows the secret can read every transfer of the pool.
//
// A key may be published for a public test pool, so that anyone can try the auditor's view.
// Never reuse such a key on a network that holds real money.
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as C from "./lib/protocol.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[++i];
}
const network = args.network ?? "testnet";
const file = join(import.meta.dirname, "..", "ceremony", `${network}-auditor-key.json`);
if (existsSync(file)) {
  console.error(`${file} already exists. The pool's auditor key cannot be replaced silently; keep the file.`);
  process.exit(1);
}

const { secret, pubKey } = C.auditorKeyPair();
if (!C.isAuditorKey(pubKey)) throw new Error("generated a key the pool would refuse");

writeFileSync(file, JSON.stringify({
  network,
  note: network === "testnet"
    ? "PUBLIC TEST KEY. Anyone can read the transfers of the testnet pool. Never reuse on a network that holds real money."
    : "Keep this file offline and never share it.",
  curve: "BabyJubJub, twisted Edwards, base point of the prime-order subgroup",
  basePoint: C.BASE8.map(String),
  secret: secret.toString(),
  pubKey: pubKey.map(String),
}, null, 2) + "\n");

console.log(`written ${file}`);
console.log(`auditor public key: [${pubKey[0].toString()}, ${pubKey[1].toString()}]`);
