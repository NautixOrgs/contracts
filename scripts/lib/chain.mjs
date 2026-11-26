// Chain access for the scripts: networks, compiled contracts, a local deployment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http } from "viem";

export const ROOT = join(import.meta.dirname, "..", "..");

export const NETWORKS = {
  testnet: {
    chainId: 46630,
    name: "Robinhood Chain Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
  },
};

export const chainFor = (chainId, name) => ({
  id: chainId,
  name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

/** A compiled contract from build/forge: its ABI and creation code. */
export function artifact(file, name) {
  const a = JSON.parse(readFileSync(join(ROOT, "build/forge", `${file}.sol`, `${name}.json`), "utf8"));
  if (!a.bytecode?.object) throw new Error(`${name} has no bytecode; run forge build`);
  return { abi: a.abi, bytecode: a.bytecode.object.startsWith("0x") ? a.bytecode.object : "0x" + a.bytecode.object };
}

let compiled = null;

/** ABI and creation code of the four contracts, read once from build/forge. */
export function contracts() {
  compiled ??= {
    hasher: artifact("Hasher", "Hasher"),
    verifier: artifact("Verifier", "Groth16Verifier"),
    pool: artifact("Pool", "Pool"),
    registry: artifact("Registry", "Registry"),
  };
  return compiled;
}

/** Public, wallet and (on a local node) test clients for one RPC. */
export function clients(rpc, chainId, name) {
  const chain = chainFor(chainId, name);
  return {
    chain,
    pub: createPublicClient({ chain, transport: http(rpc) }),
    wallet: createWalletClient({ chain, transport: http(rpc) }),
  };
}

/** Enough for a deposit; Arbitrum reports a failed gas estimate as "insufficient funds". */
export const GAS = 4_000_000n;

/** Deploys one contract and returns its address and the block it was mined in. */
export async function deploy(wallet, pub, account, { abi, bytecode }, args = []) {
  const hash = await wallet.deployContract({ abi, bytecode, args, account, gas: GAS });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`deployment of ${args.length ? "Pool" : "a contract"} failed: ${hash}`);
  return { address: rc.contractAddress, block: rc.blockNumber, hash, gas: rc.gasUsed };
}
