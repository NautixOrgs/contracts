// End-to-end check of the whole system with real Groth16 proofs: the contracts, the client
// logic, the relayer's role and the auditor's ledger.
//
//   node scripts/smoke-test.mjs
//       Starts a local node with the chain id of the testnet, deploys the four contracts and
//       runs the flow. Nothing leaves this machine.
//
//   DEPLOYER_KEY=0x... node scripts/smoke-test.mjs --network testnet
//       Runs the same flow against the deployment recorded in deployments/<chainId>.json,
//       with small amounts. DEPLOYER_KEY's wallet plays the depositor.
//
// The second user's wallet, the relayer's wallet and the two pool identities are created
// once and kept in build/<network>-test-wallets.json (not committed, mode 600), so that later
// runs reuse them and no test ETH is left behind in wallets nobody can open. --fresh makes
// new ones. The checks compare how balances change, so they hold on a pool that is not empty.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestClient, http, parseEther, getAddress, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS, ROOT, contracts, clients, deploy, GAS } from "./lib/chain.mjs";
import * as C from "./lib/protocol.mjs";
import { prove, stopWorkers } from "./lib/witness.mjs";
import { deriveKeysFromLabel } from "./lib/keys.mjs";
import { Client } from "./lib/client.mjs";
import { readLedger, describe, ledgerHash } from "./lib/auditor.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[++i];
}
const live = args.network !== undefined;
const net = live ? NETWORKS[args.network] : null;
if (live && !net) { console.error("unknown network; known: " + Object.keys(NETWORKS).join(", ")); process.exit(1); }

const say = (m = "") => console.log(m);
const checked = [];
const check = (ok, what) => {
  if (!ok) throw new Error("CHECK FAILED: " + what);
  checked.push(what);
  say("  ok  " + what);
};
const eth = (wei) => `${wei} wei (${Number(wei) / 1e18} ETH)`;
const randomLabel = () => Math.random().toString(36).slice(2);

// ------------------------------------------------------------------ environment
let anvil = null, testc = null, auditor, pub, wallet;
let chainId, deployment, owner, aliceWallet, bobWallet, relayerWallet, amounts;

if (!live) {
  const port = Number(args.port ?? 8591);
  const rpc = `http://127.0.0.1:${port}`;
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "46630", "--silent"], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      up = !!(await r.json()).result;
    } catch { /* not up yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { anvil.kill(); throw new Error("anvil did not start"); }
  chainId = 46630;
  ;({ pub, wallet } = clients(rpc, chainId, "Robinhood Chain (local copy)"));
  testc = createTestClient({ mode: "anvil", transport: http(rpc), chain: { id: chainId, name: "local" } });
  // Fresh random keys, as on a real chain: never a published test key.
  const fresh = async (ethAmount) => {
    const account = privateKeyToAccount(generatePrivateKey());
    await testc.setBalance({ address: account.address, value: parseEther(ethAmount) });
    return account;
  };
  owner = await fresh("100");
  aliceWallet = await fresh("100");
  bobWallet = await fresh("100");
  relayerWallet = await fresh("100");
  auditor = C.auditorKeyPair();

  say("deploying on the local node");
  const c = contracts();
  const hasher = await deploy(wallet, pub, owner, c.hasher);
  const verifier = await deploy(wallet, pub, owner, c.verifier);
  const pool = await deploy(wallet, pub, owner, c.pool, [verifier.address, hasher.address, 24, 1000, auditor.pubKey.map(String), parseEther("0.1"), parseEther("5"), owner.address]);
  const registry = await deploy(wallet, pub, owner, c.registry);
  deployment = { chainId, pool: pool.address, registry: registry.address, fromBlock: Number(pool.block), owner: owner.address, levels: 24, rootHistorySize: 1000, auditorKey: auditor.pubKey.map(String), maxDeposit: parseEther("0.1").toString(), poolCap: parseEther("5").toString() };
  amounts = { deposit: parseEther("0.05"), pay: parseEther("0.03"), fee: parseEther("0.001"), withdraw: parseEther("0.02"), fund: 0n };
} else {
  const file = join(ROOT, "deployments", `${net.chainId}.json`);
  if (!existsSync(file)) { console.error(`no deployment record at ${file}`); process.exit(1); }
  const record = JSON.parse(readFileSync(file, "utf8"));
  const key = process.env.DEPLOYER_KEY;
  if (!key) { console.error("set DEPLOYER_KEY to the deployer's private key; it plays the depositor"); process.exit(1); }
  ;({ pub, wallet } = clients(net.rpc, net.chainId, net.name));
  chainId = net.chainId;
  deployment = record;
  // The auditor key file made for this network holds the secret the pool's records are sealed to.
  const auditorFile = JSON.parse(readFileSync(join(ROOT, "ceremony", `${args.network}-auditor-key.json`), "utf8"));
  auditor = { secret: BigInt(auditorFile.secret), pubKey: auditorFile.pubKey.map(BigInt) };
  assert.deepEqual(auditor.pubKey, record.auditorKey.map(BigInt), "the auditor key file does not match the deployment");
  aliceWallet = privateKeyToAccount(key);
  owner = { address: record.owner };
  // What the second user needs to register, and the relayer to send two transactions.
  amounts = { deposit: parseEther(args.deposit ?? "0.0005"), pay: parseEther("0.0003"), fee: parseEther("0.00001"), withdraw: parseEther("0.0002"),
    userNeeds: parseEther("0.0002"), relayerNeeds: parseEther("0.0003") };
}

// ---------------------------------------------------------------- wallets and identities, kept between runs
const walletsFile = join(ROOT, "build", `${live ? args.network : "local"}-test-wallets.json`);
const makeNew = args.fresh === true;
let saved = {};
if (!makeNew && existsSync(walletsFile)) saved = JSON.parse(readFileSync(walletsFile, "utf8"));
const wallets = {
  userKey: process.env.USER_KEY ?? saved.userKey ?? generatePrivateKey(),
  relayerKey: process.env.RELAYER_KEY ?? saved.relayerKey ?? generatePrivateKey(),
  // The pool identities are derived from these labels.
  aliceLabel: saved.aliceLabel ?? `alice-${randomLabel()}`,
  bobLabel: saved.bobLabel ?? `bob-${randomLabel()}`,
};
mkdirSync(join(ROOT, "build"), { recursive: true });
writeFileSync(walletsFile, JSON.stringify(wallets, null, 2) + "\n", { mode: 0o600 });
if (live) {
  bobWallet = privateKeyToAccount(wallets.userKey);
  relayerWallet = privateKeyToAccount(wallets.relayerKey);
}

const poolAbi = contracts().pool.abi;
const read = (functionName, args = []) => pub.readContract({ address: deployment.pool, abi: poolAbi, functionName, args });
const balanceOf = (address) => pub.getBalance({ address });

try {
  const title = live ? `LIVE on ${net.name} (${chainId})` : "LOCAL node (chain id 46630)";
  say(`\n=== Shielded pool end-to-end: ${title} ===`);
  say(`pool      ${deployment.pool}\nregistry  ${deployment.registry}`);

  // ---------------------------------------------------------------- the deployment
  say("\n-- deployment checks");
  check((await pub.getChainId()) === chainId, "the RPC answers for the right chain");
  check(await read("isKnownRoot", [await read("lastRoot")]), "the pool knows its current root");
  if (!live) check((await read("lastRoot")) === new C.Tree(24).root, "a fresh pool starts from the empty tree root");
  check((await read("levels")) === 24, "the pool's tree is 24 levels deep, as the circuit's");
  check((await read("auditorKey")).map(String).join() === deployment.auditorKey.map(String).join(), "the auditor key is the one recorded");
  check(getAddress(await read("owner")) === getAddress(deployment.owner), "the owner is the one recorded");
  const maxDeposit = await read("maxDeposit");
  check(maxDeposit === BigInt(deployment.maxDeposit), "the deposit limit is the one recorded");

  if (live) {
    // The other wallets need gas money. The deployer tops them up only when they are short.
    let toSend = 0n;
    for (const [who, account, needs] of [["user", bobWallet, amounts.userNeeds], ["relayer", relayerWallet, amounts.relayerNeeds]]) {
      const have = await balanceOf(account.address);
      const short = have < needs ? needs - have : 0n;
      toSend += short;
      if (short > 0n) {
        const hash = await wallet.sendTransaction({ account: aliceWallet, to: account.address, value: short, gas: 21000n });
        await pub.waitForTransactionReceipt({ hash });
      }
      say(`  ${who.padEnd(7)} wallet ${account.address} holds ${eth(await balanceOf(account.address))}`);
    }
    const have = await balanceOf(aliceWallet.address);
    check(have > amounts.deposit + parseEther("0.0001"), `the depositor can afford the flow (holds ${eth(have)})`);
  }
  check(amounts.deposit <= maxDeposit, `the deposit of ${eth(amounts.deposit)} is within the limit`);

  // ---------------------------------------------------------------- keys and clients
  say("\n-- keys");
  const aliceKeys = await deriveKeysFromLabel(wallets.aliceLabel, chainId);
  const bobKeys = await deriveKeysFromLabel(wallets.bobLabel, chainId);
  const mk = (keys, account) => new Client({ publicClient: pub, walletClient: wallet, account, deployment, keys, prove: (signals) => prove(signals) });
  const alice = mk(aliceKeys, aliceWallet);
  const bob = mk(bobKeys, bobWallet);
  const relay = { account: relayerWallet, fee: amounts.fee };
  say(`  Alice pool key ${aliceKeys.pubKey.toString(16).slice(0, 16)}...  wallet ${aliceWallet.address}`);
  say(`  Bob   pool key ${bobKeys.pubKey.toString(16).slice(0, 16)}...  wallet ${bobWallet.address}`);
  say(`  (wallets and labels kept in ${walletsFile.replace(ROOT + "/", "")}, not committed)`);

  const receiptOf = async (label, promise) => {
    const rc = await promise;
    say(`  ${label.padEnd(24)} gas ${rc.gasUsed}  tx ${rc.transactionHash}`);
    return rc;
  };

  // ---------------------------------------------------------------- register
  say("\n-- register");
  await receiptOf("Alice registers", alice.register());
  await receiptOf("Bob registers", bob.register());
  const bobAddress = await alice.lookup(bobWallet.address);
  check(bobAddress?.pubKey === bobKeys.pubKey && bobAddress.encKey === bobKeys.encKey, "Alice finds Bob's shielded address by his wallet address");
  check((await alice.lookup(aliceWallet.address))?.pubKey === aliceKeys.pubKey, "Alice finds her own shielded address");

  if (!live) {
    // Leave balances behind first, so that the flow below also runs on a pool that has been
    // used, as it is on any shared pool.
    await alice.deposit(parseEther("0.01"));
    await alice.transfer(bobWallet.address, parseEther("0.004"));
    say("  warm-up: two transactions sent directly, so the pool is not empty from here on");
  }

  // ---------------------------------------------------------------- deposit
  say("\n-- deposit");
  const aliceBefore = await alice.sync();
  const bobBefore = await bob.sync();
  say(`  before: Alice ${eth(aliceBefore)}, Bob ${eth(bobBefore)}`);
  const heldBefore = await read("totalHeld");
  const poolEthBefore = await balanceOf(deployment.pool);
  const r1 = await receiptOf("Alice deposits", alice.deposit(amounts.deposit));
  check((await alice.balance) - aliceBefore === amounts.deposit, "Alice's private balance grew by the deposit");
  check((await read("totalHeld")) === heldBefore + amounts.deposit, "the pool counted exactly the deposit");
  check((await balanceOf(deployment.pool)) - poolEthBefore === amounts.deposit, "the pool's ETH grew by exactly the deposit");
  check((await bob.sync()) === bobBefore, "Bob's balance did not move: he sees none of it");
  const gas = { deposit: r1.gasUsed };

  // ---------------------------------------------------------------- private transfer through a relayer
  say("\n-- private transfer through the relayer");
  const relayerBefore = await balanceOf(relayerWallet.address);
  const aliceWalletBefore = await balanceOf(aliceWallet.address);
  const r2 = await receiptOf("Alice pays Bob", alice.transfer(bobWallet.address, amounts.pay, relay));
  gas.transfer = r2.gasUsed;
  check((await alice.balance) - aliceBefore === amounts.deposit - amounts.pay - amounts.fee, "Alice's balance dropped by the amount and the fee");
  check((await bob.sync()) - bobBefore === amounts.pay, "Bob's private balance grew by exactly the payment");
  check((await pub.getTransaction({ hash: r2.transactionHash })).from.toLowerCase() === relayerWallet.address.toLowerCase(), "the relayer, not Alice's wallet, sent the transaction");
  check(await balanceOf(aliceWallet.address) === aliceWalletBefore, "Alice's wallet paid no gas for it");
  check((await balanceOf(relayerWallet.address)) > relayerBefore - parseEther(live ? "0.00005" : "0.01"), "the relayer was paid its fee (minus its own gas)");
  const poolBalanceAfter = await balanceOf(deployment.pool);
  check(poolBalanceAfter >= (await read("totalHeld")), "the pool still holds at least what the notes are worth");

  // ---------------------------------------------------------------- restore from nothing
  say("\n-- restore from nothing");
  const stranger = mk(await deriveKeysFromLabel(`stranger-${randomLabel()}`, chainId), bobWallet);
  check(await stranger.sync() === 0n, "a client with other keys sees no balance at all");
  // A client that holds nothing but Bob's keys: a new object with no memory of anything.
  const restored = mk(bobKeys, bobWallet);
  check(await restored.sync() === await bob.balance, "a fresh client with only Bob's keys recovers his balance");
  check(restored.unspent.length === bob.unspent.length, "and the same notes");

  // ---------------------------------------------------------------- withdraw
  say("\n-- withdraw");
  const sink = "0x" + "00".repeat(18) + "c0de"; // a fresh address nobody holds the key of
  const sinkBefore = await balanceOf(sink);
  const bobNow = await bob.balance;
  const r3 = await receiptOf("Bob withdraws", bob.withdraw(sink, amounts.withdraw, relay));
  gas.withdraw = r3.gasUsed;
  check(await balanceOf(sink) === sinkBefore + amounts.withdraw, "the outside address received exactly the amount");
  check((await bob.balance) - bobNow === -(amounts.withdraw + amounts.fee), "Bob's private balance dropped by the amount and the fee");
  const ledgerSum = (await alice.balance) + (await bob.balance);
  const held = await read("totalHeld");
  if (live) {
    // A shared pool also holds what earlier users left in it. That this run's users own no more
    // than the pool holds is checked here; that everybody's notes add up to the pool exactly is
    // the auditor's check below, which sees every pool key.
    // On a shared pool other keys hold the rest; the auditor's check below covers everybody.
    check(held >= ledgerSum, `Alice's and Bob's balances (${eth(ledgerSum)}) are covered by the pool's totalHeld (${eth(held)})`);
  } else {
    check(ledgerSum === held, `the private balances add up to the pool's totalHeld (${eth(held)})`);
  }

  // ---------------------------------------------------------------- refused
  say("\n-- refused");
  const refused = async (label, request, error) => {
    let seen = "";
    try { await pub.simulateContract({ ...request, abi: poolAbi, gas: GAS }); } catch (e) {
      // The reason sits at different depths of the error chain: a decoded name where the ABI
      // is known, otherwise the four bytes of revert data the RPC returned.
      for (let at = e; at; at = at.cause) {
        if (at.errorName) seen += at.errorName + " | ";
        if (typeof at.data === "string") seen += at.data + " | ";
        if (at.data && typeof at.data.data === "string") seen += at.data.data + " | ";
        if (at.details) seen += at.details + " | ";
      }
    }
    // viem reports a custom error by name or, without the ABI, by its four-byte selector.
    const selector = toFunctionSelector(`function ${error}()`);
    check(seen.includes(error) || seen.includes(selector), `${label} is refused with ${error} (saw: ${seen.slice(0, 120) || "nothing"})`);
  };
  await refused("sending the same proof again", bob.lastRequest, "NullifierUsed");

  // A fresh transaction that was never sent: editing any part of it breaks the proof. It
  // spends Alice's two largest notes into one, like a merge.
  const spareInputs = [...alice.unspent].sort((a, b) => (a.note.amount < b.note.amount ? 1 : -1)).slice(0, 2);
  const spareSum = spareInputs.reduce((sum, n) => sum + n.note.amount, 0n);
  const spare = { inputs: spareInputs, outputs: [{ amount: spareSum - amounts.fee, pubKey: aliceKeys.pubKey, encKey: aliceKeys.encKey }], relay };
  const prepared = await alice.prepare(spare);
  const withExt = (change) => ({ ...prepared, args: [prepared.args[0], { ...prepared.args[1], ...change }] });
  await refused("editing the recipient", withExt({ recipient: aliceWallet.address }), "InvalidProof");
  await refused("raising the fee", withExt({ fee: amounts.fee + 1n }), "InvalidProof");
  await refused("paying the fee to someone else", withExt({ relayer: aliceWallet.address }), "InvalidProof");
  await refused("replacing an encrypted note", withExt({ note0: "0xdead" }), "InvalidProof");
  await refused("swapping the two commitments", { ...prepared, args: [{ ...prepared.args[0], commitments: [prepared.args[0].commitments[1], prepared.args[0].commitments[0]] }, prepared.args[1]] }, "InvalidProof");
  check((await alice.balance) - aliceBefore === amounts.deposit - amounts.pay - amounts.fee, "none of that moved anything");

  // ---------------------------------------------------------------- auditor
  say("\n-- auditor");
  const ledger = await readLedger({ publicClient: pub, pool: deployment.pool, registry: deployment.registry, fromBlock: deployment.fromBlock, secret: auditor.secret });
  for (const r of ledger.records) say("  " + (r.readable ? `[${r.kind}] ${describe(r)}` : r.kind));
  const transactionsSoFar = Math.floor(Number(await read("nextIndex")) / 2);
  check(ledger.records.length === transactionsSoFar, `one record per transaction (${transactionsSoFar} on this pool)`);
  if (live) check(transactionsSoFar >= 3, "the three transactions of this run are among them");
  check(ledger.unreadable === 0, "the auditor can read every record");
  check(ledger.reconciled === true, `the auditor's balances add up to the pool's ETH (${eth(ledger.total)})`);
  const bobRow = ledger.holders.find((h) => h.pubKey === bobKeys.pubKey);
  check(bobRow?.balance === await bob.balance && getAddress(bobRow.address) === getAddress(bobWallet.address), "Bob's pool key is tied to his wallet address, with the right balance");
  const blind = await readLedger({ publicClient: pub, pool: deployment.pool, registry: deployment.registry, fromBlock: deployment.fromBlock, secret: C.auditorKeyPair().secret });
  check(blind.unreadable === ledger.records.length && blind.reconciled !== true, "another key opens nothing");

  // ---------------------------------------------------------------- summary
  say("\n=== summary ===");
  say(`checks passed   ${checked.length}`);
  say(`gas deposit     ${gas.deposit}`);
  say(`gas transfer    ${gas.transfer}  (paid by the relayer)`);
  say(`gas withdraw    ${gas.withdraw}  (paid by the relayer)`);
  say(`ledger hash     ${ledgerHash(ledger)}`);
  say("Everything checked out.");
} catch (err) {
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  anvil?.kill();
  stopWorkers();
}
process.exit(process.exitCode ?? 0);
