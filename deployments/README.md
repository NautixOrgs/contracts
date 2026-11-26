# Deployments

One record per chain: `<chain id>.json`.

`script/Deploy.s.sol` writes the record while it simulates, with the addresses and the settings. `scripts/record-deployment.mjs` completes it from the receipts: the transactions with their blocks and gas, the size of the code at every address, whether the explorer has the source verified, and the digests of the proving key.

The tools that work on a deployment read it: `scripts/smoke-test.mjs --network <network>`, `scripts/audit.mjs`, and the client through its `deployment` object.

This repository publishes no addresses, so `deployments/*.json` is ignored by git. A team that deploys its own pool keeps its records wherever it publishes them; to commit them here instead, remove that line from `.gitignore`.

The directory has to exist before a deployment. The deploy script writes its record into it, and when the directory is missing the script deploys, passes every read-back check, and then fails on that last step. This file is what keeps the directory in a fresh clone.
