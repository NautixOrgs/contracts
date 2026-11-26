# Contributing

Thank you for helping. The repository is small, and the rules that matter are few.

## Set up

Follow [Getting started](README.md#getting-started) in the README. In short:

```bash
npm ci
cargo install circom --git https://github.com/iden3/circom.git --tag v2.2.3 --root .tools --locked
node scripts/build-circuit.mjs
```

## Before you open a pull request

Run the tests your change touches, or all of them if you are unsure:

```bash
forge test                        # the contracts, with the committed proofs
node --test tests/*.test.mjs      # the circuit and the protocol mathematics
node scripts/smoke-test.mjs       # the whole flow on a local node
```

CI runs the first two on every push and every pull request.

## Generated files

Never edit these by hand. Change the generator, then run it.

| File | Made by |
| --- | --- |
| `src/Hasher.sol` | `node scripts/gen-hasher.mjs` |
| `src/Verifier.sol` | `node scripts/setup-proving-key.mjs` |
| `test/FixtureData.sol`, `test/fixtures/hasher-vectors.json`, `curve-points.json`, `proofs.json` | `node scripts/gen-fixtures.mjs` |

Three properties are worth protecting:

- From an unchanged tree, `node scripts/gen-hasher.mjs` and `node scripts/gen-fixtures.mjs --reuse` reproduce the committed files byte for byte.
- `src/Verifier.sol` must keep the sha256 recorded as `verifierSha256` in `ceremony/<network>.json`.
- Compiling the circuit with circom 2.2.3 must give the `r1cs` and `wasm` digests recorded in the same file.

A pull request that changes a generated file without changing its generator, or the ceremony record, will be questioned.

`test/fixtures/tree-vectors.json` is read, not written. It holds known-answer vectors recorded from a pool that ran the protocol. Keep it as it is.

## Committing

- Branch from `main`. Give the branch and the pull request a name that says what changes.
- Use [Conventional Commits](https://www.conventionalcommits.org) for the title: `fix(pool): ...`, `feat(circuit): ...`, `docs: ...`.
- One logical change per pull request. A change to the circuit is its own pull request, with the figures from `node scripts/circuit-report.mjs` in its description, because every change to the circuit means a new proving key.
- Add or change a test for every change in behaviour. A bug fix starts with the test that shows the bug.

## What must never be committed

- A private key, a mnemonic, a signature used for key derivation, or an auditor secret. `.env*`, `ceremony/*-auditor-key.json`, `ceremony/local.json` and `build/` are ignored by git for that reason. If a secret was pushed, consider it public: rotate it first, then clean the history.
- A proving key, a phase-1 file or a witness: `*.zkey`, `*.ptau`, `*.wtns`.
- A deployment record, `deployments/*.json`. This repository publishes no addresses.

## Security

A vulnerability is not a pull request and not a public issue. See [SECURITY.md](SECURITY.md).

## Conduct

Be constructive and specific. Review the code, not the person. Ask before changing a design choice whose reason is not clear.
