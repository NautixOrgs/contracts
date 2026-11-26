// The auditor tool. Reads a pool's public events, opens the copies sealed to the auditor
// key, rebuilds every participant's balance and checks the total against the pool.
//
//   node scripts/audit.mjs --network testnet [--format text|json|csv] [--key FILE]
//
// --key names a file holding the auditor secret (`secret`, `pubKey`). The default is
// ceremony/<network>-auditor-key.json, made by scripts/gen-auditor-key.mjs. For real money keep
// such a file offline and never type the secret into a browser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NETWORKS, ROOT, clients } from "./lib/chain.mjs";
import { readLedger, describe, formatEth, toCsv, ledgerHash } from "./lib/auditor.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[++i];
}
const network = args.network ?? "testnet";
const net = NETWORKS[network];
if (!net) { console.error("usage: node scripts/audit.mjs --network " + Object.keys(NETWORKS).join("|")); process.exit(1); }
const format = args.format ?? "text";

const record = JSON.parse(readFileSync(join(ROOT, "deployments", `${net.chainId}.json`), "utf8"));
const keyFile = args.key ?? join(ROOT, "ceremony", `${network}-auditor-key.json`);
const key = JSON.parse(readFileSync(keyFile, "utf8"));
const { pub } = clients(net.rpc, net.chainId, net.name);

const ledger = await readLedger({ publicClient: pub, pool: record.pool, registry: record.registry, fromBlock: record.fromBlock, secret: BigInt(key.secret) });

if (format === "json") {
  console.log(JSON.stringify({ pool: record.pool, ...ledger }, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
} else if (format === "csv") {
  process.stdout.write(toCsv(ledger));
} else {
  console.log(`Pool ${record.pool} on ${net.name}, from block ${record.fromBlock}`);
  console.log(`Auditor key sealed to: ${ledger.pubKey.map(String).join(", ")}`);
  console.log(`Records: ${ledger.records.length} (${ledger.unreadable} unreadable with this key)\n`);
  for (const r of ledger.records) console.log(`  block ${r.block}  ${r.readable ? `[${r.kind.padEnd(8)}] ${describe(r)}` : r.kind}`);
  console.log(`\nBalances by pool key:`);
  for (const h of ledger.holders) console.log(`  ${formatEth(h.balance).padStart(12)} ETH  ${h.address ?? `key ${h.pubKey.toString(16).slice(0, 12)}... (address not registered)`}`);
  console.log(`\nSum of balances: ${formatEth(ledger.total)} ETH`);
  console.log(`Pool totalHeld:  ${formatEth(ledger.totalHeld)} ETH`);
  console.log(ledger.reconciled === null ? "Reconciliation: not possible, some records are sealed to another key"
    : ledger.reconciled ? "Reconciliation: the balances add up to the pool" : "Reconciliation: MISMATCH");
  console.log(`Ledger hash: ${ledgerHash(ledger)}`);
}
process.exit(ledger.reconciled === true ? 0 : 1);
