// Completes the deployment record after `forge script Deploy --broadcast`.
//
//   node scripts/record-deployment.mjs --network testnet
//
// The deploy script writes addresses and settings while it simulates, where no real block
// exists yet. This adds what only the receipts know: the block to read events from, the
// deployment transactions and their gas. It then reads the chain to confirm that code is at
// every address and that the explorer has the source verified.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NETWORKS, contracts } from "./lib/chain.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[++i];
}
const net = NETWORKS[args.network];
if (!net) { console.error("usage: node scripts/record-deployment.mjs --network " + Object.keys(NETWORKS).join("|")); process.exit(1); }

const recordFile = join(import.meta.dirname, "..", "deployments", `${net.chainId}.json`);
const broadcastFile = join(import.meta.dirname, "..", "broadcast", "Deploy.s.sol", `${net.chainId}`, "run-latest.json");
if (!existsSync(recordFile) || !existsSync(broadcastFile)) { console.error("deploy first: forge script script/Deploy.s.sol --broadcast"); process.exit(1); }
const record = JSON.parse(readFileSync(recordFile, "utf8"));
const broadcast = JSON.parse(readFileSync(broadcastFile, "utf8"));
const chainName = args.network;

const rpc = async (method, params) => {
  const r = await fetch(net.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const out = await r.json();
  if (out.error) throw new Error(`${method}: ${JSON.stringify(out.error)}`);
  return out.result;
};

// ---- from the receipts
const transactions = broadcast.transactions.map((t, i) => {
  const r = broadcast.receipts[i];
  if (!r || r.transactionHash !== t.hash) throw new Error(`no receipt for transaction ${t.hash}`);
  return { name: t.contractName, address: r.contractAddress, hash: t.hash, block: Number(BigInt(r.blockNumber)),
    status: Number(BigInt(r.status)), gasUsed: Number(BigInt(r.gasUsed)), effectiveGasPrice: BigInt(r.effectiveGasPrice).toString() };
});
if (transactions.some((t) => t.status !== 1)) throw new Error("a deployment transaction failed");
const firstBlock = Math.min(...transactions.map((t) => t.block));
const gasUsed = transactions.reduce((s, t) => s + t.gasUsed, 0);
const costWei = transactions.reduce((s, t) => s + BigInt(t.gasUsed) * BigInt(t.effectiveGasPrice), 0n);

for (const t of transactions) {
  const recorded = record[t.name === "Groth16Verifier" ? "verifier" : t.name.toLowerCase()];
  if (recorded.toLowerCase() !== t.address.toLowerCase()) throw new Error(`record and receipt disagree on ${t.name}`);
}

// ---- from the chain
const onChain = {};
for (const key of ["hasher", "verifier", "pool", "registry"]) {
  const code = await rpc("eth_getCode", [record[key], "latest"]);
  const size = (code.length - 2) / 2;
  if (size === 0) throw new Error(`no code at ${key} ${record[key]}`);
  onChain[key] = size;
}

// ---- from the explorer
const verified = {};
for (const key of ["hasher", "verifier", "pool", "registry"]) {
  const r = await fetch(`${net.explorer}/api/v2/smart-contracts/${record[key]}`);
  const out = r.ok ? await r.json() : {};
  verified[key] = !!out.is_verified;
}

const ceremony = record.ceremonyRecord && existsSync(join(import.meta.dirname, "..", record.ceremonyRecord))
  ? JSON.parse(readFileSync(join(import.meta.dirname, "..", record.ceremonyRecord), "utf8"))
  : null;

const out = {
  ...record,
  chainName: net.name,
  explorer: net.explorer,
  // Reading from a few blocks before the first deployment is harmless: these addresses hold
  // nothing before then.
  fromBlock: firstBlock - 5,
  deploymentBlock: firstBlock,
  transactions,
  deploymentGasUsed: gasUsed,
  deploymentCostWei: costWei.toString(),
  codeBytes: onChain,
  verified,
  provingKey: ceremony ? { file: "build/keys/transact.zkey", sha256: ceremony.finalKeySha256, verifierSha256: ceremony.verifierSha256,
    circuit: { r1csSha256: ceremony.circuit.r1csSha256, wasmSha256: ceremony.circuit.wasmSha256 } } : null,
};
writeFileSync(recordFile, JSON.stringify(out, null, 2) + "\n");

console.log(`${net.name} (${net.chainId})`);
for (const t of transactions) console.log(`  ${t.name.padEnd(16)} ${t.address}  block ${t.block}  gas ${t.gasUsed}  verified ${verified[t.name === "Groth16Verifier" ? "verifier" : t.name.toLowerCase()]}`);
console.log(`  total gas ${gasUsed}, cost ${Number(costWei) / 1e18} ETH`);
console.log(`  fromBlock ${out.fromBlock}`);
console.log(`written ${recordFile}`);
if (Object.values(verified).some((v) => !v)) {
  console.log("not every contract is verified on the explorer yet; run this again once the explorer's queue has caught up");
  process.exit(2);
}
