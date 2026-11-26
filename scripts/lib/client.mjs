// The client: reads the pool's events, finds the notes that belong to one set of keys, and
// builds deposits, private transfers and withdrawals. It keeps nothing on a server; the whole
// balance is rebuilt from the chain.
//
//   new Client({ publicClient, walletClient, account, deployment, keys, prove })
//
//   account     the wallet that pays gas for deposits and for transactions sent directly
//   deployment  { chainId, pool, registry, fromBlock }
//   keys        from deriveKeys()
//   prove       async (signals) => { proof, publicSignals }
import { encodeAbiParameters, keccak256, parseEventLogs } from "viem";
import * as C from "./protocol.mjs";
import { encryptNote, decryptNote } from "./notes.mjs";
import { contracts, GAS } from "./chain.mjs";

const poolAbi = () => contracts().pool.abi;
const registryAbi = () => contracts().registry.abi;

const EXT_TYPES = [
  { type: "address" }, { type: "int256" }, { type: "address" }, { type: "uint256" },
  { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" },
];
const ZERO = "0x" + "00".repeat(20);

/** Must equal Pool.extDataHash. */
export function hashExt(ext, pool, chainId) {
  return BigInt(keccak256(encodeAbiParameters(EXT_TYPES, [
    ext.recipient, ext.extAmount, ext.relayer, ext.fee,
    keccak256(ext.note0), keccak256(ext.note1), BigInt(chainId), pool]))) % C.P;
}

/** A proof in the shape the pool contract takes, from the proof and the signals it was made for. */
export function poolProofOf(proof, signals) {
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

export class Client {
  constructor({ publicClient, walletClient, account, deployment, keys, prove, logChunk = 2_000_000n }) {
    Object.assign(this, { publicClient, walletClient, account, deployment, keys, prove, logChunk });
    this.address = typeof account === "string" ? account : account.address;
    this.tree = new C.Tree();
    this.notes = [];
    this.spent = new Set();
    this.cursor = BigInt(deployment.fromBlock ?? 0);
  }

  // ---------------------------------------------------------------- reading

  /** Brings the local tree and the note list up to the latest block. */
  async sync() {
    // No block-number cache: a sync right after our own transaction must see its block.
    const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    let span = this.logChunk;
    for (let from = this.cursor; from <= latest;) {
      const to = from + span - 1n < latest ? from + span - 1n : latest;
      const range = { address: this.deployment.pool, fromBlock: from, toBlock: to };
      let added, nulled;
      try {
        // Ask for a wide block range and narrow it only if the node objects: blocks on this
        // chain come several per second, so small fixed ranges would mean thousands of requests.
        [added, nulled] = await Promise.all([
          this.publicClient.getContractEvents({ ...range, abi: poolAbi(), eventName: "NewCommitment" }),
          this.publicClient.getContractEvents({ ...range, abi: poolAbi(), eventName: "NewNullifier" }),
        ]);
      } catch (err) {
        if (span <= 2000n) throw err;
        span /= 4n;
        continue;
      }
      from = to + 1n;
      added.sort((x, y) => Number(x.args.index) - Number(y.args.index));
      for (const log of added) {
        const { commitment, index, note } = log.args;
        if (Number(index) !== this.tree.size) throw new Error(`commitment ${index} arrived out of order`);
        this.tree.insert(commitment);
        const mine = await decryptNote(note, this.keys.encPriv);
        if (!mine || mine.amount === 0n) continue;
        const full = { amount: mine.amount, pubKey: this.keys.pubKey, blinding: mine.blinding };
        // A sender can seal anything; only a note that matches its commitment is money.
        if (C.commitmentOf(full) !== commitment) continue;
        this.notes.push({ note: full, index: Number(index), nullifier: C.nullifierOf(commitment, index, this.keys.privKey), block: log.blockNumber });
      }
      for (const log of nulled) this.spent.add(log.args.nullifier);
    }
    this.cursor = latest + 1n;
    return this.balance;
  }

  /** Own notes whose nullifier has not been published. */
  get unspent() {
    return this.notes.filter((n) => !this.spent.has(n.nullifier));
  }

  get balance() {
    return this.unspent.reduce((sum, n) => sum + n.note.amount, 0n);
  }

  readPool(functionName, args = []) {
    return this.publicClient.readContract({ address: this.deployment.pool, abi: poolAbi(), functionName, args });
  }

  /** The shielded address a wallet published, or null. */
  async lookup(address) {
    const [pubKey, encKey] = await this.publicClient.readContract({ address: this.deployment.registry, abi: registryAbi(), functionName: "entries", args: [address] });
    return pubKey === 0n ? null : { pubKey, encKey };
  }

  /** ETH the pool is holding for `address` because it could not deliver it when paid out. */
  owed(address = this.address) {
    return this.readPool("owed", [address]);
  }

  // ---------------------------------------------------------------- writing

  async _send(functionName, args, value = 0n) {
    const call = { address: this.deployment.pool, abi: poolAbi(), functionName, args, account: this.account, value, gas: GAS };
    const { request } = await this.publicClient.simulateContract(call);
    const hash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction was mined but failed.");
    await this.sync();
    return receipt;
  }

  /** Publishes this wallet's shielded address so others can pay it by its ordinary address. */
  async register() {
    const mine = await this.lookup(this.address);
    if (mine && mine.pubKey === this.keys.pubKey && mine.encKey === this.keys.encKey) return null;
    const call = { address: this.deployment.registry, abi: registryAbi(), functionName: "register", args: [this.keys.pubKey, this.keys.encKey], account: this.account, gas: 200_000n };
    const { request } = await this.publicClient.simulateContract(call);
    const hash = await this.walletClient.writeContract(request);
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Collects what the pool holds for this wallet. Sent by the wallet itself. */
  claim() {
    return this._send("claim", []);
  }

  /**
   * Builds and proves one transaction and simulates it. Returns the request a wallet or a
   * relayer can send as it is. Nothing is sent.
   *   relay: null, or { account, fee } for a relayer that will send it and is paid `fee` out of
   *          the private balance. Whoever sends it changes nothing: recipient, amount, relayer
   *          and fee are bound by the proof.
   */
  async prepare({ inputs, outputs, extAmount = 0n, recipient = ZERO, relay = null }) {
    const self = { pubKey: this.keys.pubKey, encKey: this.keys.encKey };
    const outs = [...outputs];
    while (outs.length < 2) outs.push({ amount: 0n, ...self });
    const notes = outs.map((o) => C.newNote(o.amount, o.pubKey));
    const [note0, note1] = await Promise.all(notes.map((n, i) => encryptNote(n, outs[i].encKey)));
    const ext = { recipient, extAmount, relayer: relay ? relay.account.address : ZERO, fee: relay ? relay.fee : 0n, note0, note1 };

    const auditorPubKey = [...(await this.readPool("auditorKey"))];
    const built = C.buildTransaction({ tree: this.tree, privKey: this.keys.privKey, inputs, outputs: notes,
      publicAmount: extAmount - ext.fee, extDataHash: hashExt(ext, this.deployment.pool, this.deployment.chainId), auditorPubKey });
    const { proof } = await this.prove(built.signals);
    const call = { address: this.deployment.pool, abi: poolAbi(), functionName: "transact", args: [poolProofOf(proof, built.signals), ext],
      account: relay ? relay.account : this.account, value: extAmount > 0n ? extAmount : 0n, gas: GAS };
    const { request } = await this.publicClient.simulateContract(call);
    return request;
  }

  /** Sends a prepared request and waits for it. */
  async submit(request) {
    // Kept so that a caller can show that replaying it gets nowhere.
    this.lastRequest = request;
    const hash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction was mined but failed.");
    await this.sync();
    return receipt;
  }

  /** Prepares and sends one transaction. */
  async _transact(params) {
    return this.submit(await this.prepare(params));
  }

  /** One or two notes covering `amount` plus the fee; merges notes first when two are not enough. */
  _inputsFor(amount, relay) {
    const fee = relay?.fee ?? 0n;
    if (this.balance < amount + fee) {
      throw new Error(fee ? "The private balance is too small for this amount plus the relayer fee." : "The private balance is too small for this.");
    }
    const sorted = [...this.unspent].sort((a, b) => (a.note.amount < b.note.amount ? 1 : -1));
    if (sorted[0].note.amount >= amount + fee) return { inputs: [sorted[0]], merge: false };
    if (sorted[0].note.amount + sorted[1].note.amount >= amount + fee) return { inputs: sorted.slice(0, 2), merge: false };
    // The two largest notes are not enough on their own: merge them first. This is a
    // transaction of its own, and it pays its own fee.
    const merged = sorted[0].note.amount + sorted[1].note.amount - fee;
    return { merge: true, merged };
  }

  /** `amount` in wei enters the pool as one note. Sent by the own wallet, which pays the ETH. */
  async deposit(amount) {
    await this.sync();
    return this._transact({ outputs: [{ amount, pubKey: this.keys.pubKey, encKey: this.keys.encKey }], extAmount: amount });
  }

  /** A private payment to a registered wallet address. Nothing about it is readable on chain. */
  async transfer(to, amount, relay = null) {
    if (amount <= 0n) throw new Error("Enter an amount above zero.");
    const them = await this.lookup(to);
    if (!them) throw new Error("That address has not opened a private balance yet, so it cannot be paid privately.");
    await this.sync();
    let pick = this._inputsFor(amount, relay);
    while (pick.merge) {
      await this._transact({ inputs: this.unspent.sort((a, b) => (a.note.amount < b.note.amount ? 1 : -1)).slice(0, 2),
        outputs: [{ amount: pick.merged, pubKey: this.keys.pubKey, encKey: this.keys.encKey }], relay });
      pick = this._inputsFor(amount, relay);
    }
    const left = pick.inputs.reduce((s, n) => s + n.note.amount, 0n) - amount - (relay?.fee ?? 0n);
    return this._transact({ inputs: pick.inputs, outputs: [{ amount, ...them }, { amount: left, pubKey: this.keys.pubKey, encKey: this.keys.encKey }], relay });
  }

  /** `amount` in wei leaves the pool to `recipient`. */
  async withdraw(recipient, amount, relay = null) {
    if (amount <= 0n) throw new Error("Enter an amount above zero.");
    await this.sync();
    let pick = this._inputsFor(amount, relay);
    while (pick.merge) {
      await this._transact({ inputs: this.unspent.sort((a, b) => (a.note.amount < b.note.amount ? 1 : -1)).slice(0, 2),
        outputs: [{ amount: pick.merged, pubKey: this.keys.pubKey, encKey: this.keys.encKey }], relay });
      pick = this._inputsFor(amount, relay);
    }
    const left = pick.inputs.reduce((s, n) => s + n.note.amount, 0n) - amount - (relay?.fee ?? 0n);
    return this._transact({ inputs: pick.inputs, outputs: [{ amount: left, pubKey: this.keys.pubKey, encKey: this.keys.encKey }], extAmount: -amount, recipient, relay });
  }

  /** Amounts of a receipt that a payee did not accept, per payee. They wait for claim(). */
  static heldIn(receipt) {
    return parseEventLogs({ abi: poolAbi(), logs: receipt.logs, eventName: "PaymentHeld" }).map((l) => ({ to: l.args.to, amount: l.args.amount }));
  }
}
