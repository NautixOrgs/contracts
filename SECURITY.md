# Security policy

## Scope

In scope:

- `src/Pool.sol`, `src/Registry.sol` and `src/Curve.sol`, and the generated `src/Hasher.sol` and `src/Verifier.sol`;
- `circuits/transact.circom`;
- `scripts/lib/`: the protocol mathematics, key derivation, note encryption, the client and the auditor's ledger;
- the generators under `scripts/` and the deployment script.

Out of scope: the dependencies themselves (report those to their maintainers), the mocks under `test/`, and the website and the relayer service, which are not part of this repository.

## Reporting a vulnerability

Please do not open a public issue.

1. Prefer GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**.
2. If that is not available, send a direct message to [@nautixrbh](https://x.com/nautixrbh).

A useful report says what goes wrong, where (file and function, or the circuit template), how to reproduce it, and what an attacker gains. A proof of concept is welcome, and a failing test is ideal.

## Testing a report

Reproduce it on a local node. The quick start in the README gives you a pool, a proving key and the end-to-end test in a few minutes. Please do not run an attack against a live deployment. If a live confirmation is needed, say so in the report and wait for an answer.

## What is already known

The README lists the [known limitations](README.md#known-limitations): no independent audit yet, a proving key whose phase 2 had one contributor, public deposits and withdrawals, and an auditor who can read every transfer. These are properties of the current design. They become vulnerabilities when you can show a way around them.

The following are deliberate. They are not vulnerabilities on their own:

- the owner can pause new deposits, change the limits, and rotate the auditor key after a public delay of seven days;
- ETH forced into the pool cannot be withdrawn;
- a payee that refuses ETH is paid later, through `claim()`;
- a relayer can see where a request comes from on the network.
