# Ceremony

The public record of a proving key, one file per network: `<network>.json`.

| File | In git | What it is |
| --- | --- | --- |
| `testnet.json` | yes | The record of the proving key that `src/Verifier.sol` and the committed test proofs were made with. |
| `<network>.json`, for another network | yes, once a pool depends on it | Written by `scripts/setup-proving-key.mjs`. |
| `local.json` | no | The record of a development key, made with `--network local`. |
| `<network>-auditor-key.json` | never | The pool's auditor key pair, with its secret. Written by `scripts/gen-auditor-key.mjs`. |

## What a record holds

- `circuit`: the template and its size, and the sha256 of the compiled `r1cs` and of the `wasm`, so that the record can be matched to a build.
- `phase1`: the public powers-of-tau file and its published checksum.
- `phase2`: the contribution, with its hash and the hash of the key after it, and the beacon, with the chain, the block and the block hash.
- `finalKeySha256`, `verificationKey` and `verifierSha256`: the finished key, the verifying key, and the sha256 of the `Verifier.sol` generated from it.

## Checking a record against a build

Compile the circuit and compare the digests:

```bash
node scripts/build-circuit.mjs
shasum -a 256 build/zk/transact.r1cs build/zk/transact_js/transact.wasm src/Verifier.sol
```

The first two must equal `circuit.r1csSha256` and `circuit.wasmSha256` of the record. The third must equal its `verifierSha256`, as long as `src/Verifier.sol` was generated from that record's key.

The key file itself is not part of the repository, so `snarkjs zkey verify` cannot be run from a fresh clone. The command the setup script ran is kept in the record, as `check`.

## The auditor key is not a ceremony

`<network>-auditor-key.json` holds a secret. With it, anyone can read every transfer of the pool. It is ignored by git on purpose.

For a pool that holds real money, keep the file off the machine that deploys. Never reuse a key that was published for a test pool.
