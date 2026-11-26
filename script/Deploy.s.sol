// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Pool, IHasher, IVerifier} from "../src/Pool.sol";
import {Hasher} from "../src/Hasher.sol";
import {Groth16Verifier} from "../src/Verifier.sol";
import {Registry} from "../src/Registry.sol";

/// @title Deploys the shielded pool
/// @notice Deploys Hasher, Groth16Verifier, Pool and Registry, reads everything back, and
///         writes deployments/<chainId>.json. Run scripts/record-deployment.mjs afterwards:
///         only the receipts know the block the contracts landed in.
/// @dev Settings come from environment variables:
///         DEPLOYER_KEY        private key of the deployer (required; the owner unless OWNER is set)
///         RPC_URL             RPC of the network (required)
///         AUDITOR_FILE        auditor key file made by scripts/gen-auditor-key.mjs (required)
///         ROOT_HISTORY_SIZE   default 1000
///         MAX_DEPOSIT_ETH     default 0.1
///         POOL_CAP_ETH        default 5
///         OWNER               default: the deployer
///         CEREMONY_RECORD     optional: path of ceremony/<network>.json, noted in the record
contract Deploy is Script {
    struct Config {
        uint32 rootHistorySize;
        uint256[2] auditorKey;
        uint256 maxDeposit;
        uint256 poolCap;
        address owner;
        string ceremonyRecord;
    }

    /// @dev The depth compiled into the circuit.
    uint32 internal constant LEVELS = 24;
    /// @dev Poseidon(1, 2) as the circuit computes it.
    uint256 internal constant POSEIDON_1_2 = 7853200120776062878684798364095072458815029376092732009249414926327459813530;
    /// @dev Root of the empty tree of depth 24: the chain of zero subtrees the pool computes when it is deployed.
    uint256 internal constant EMPTY_ROOT_24 = 17681057402012993898104192736393849603097507831571622013521167331642182653248;

    Hasher public hasher;
    Groth16Verifier public verifier;
    Pool public pool;
    Registry public registry;

    function run() external {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", uint256(0));
        if (deployerKey == 0) revert("DEPLOYER_KEY is not set");
        Config memory c = _config(deployerKey);

        vm.startBroadcast(deployerKey);
        hasher = new Hasher();
        verifier = new Groth16Verifier();
        pool = new Pool(IVerifier(address(verifier)), IHasher(address(hasher)), LEVELS, c.rootHistorySize, c.auditorKey, c.maxDeposit, c.poolCap, c.owner);
        registry = new Registry();
        vm.stopBroadcast();

        _check(c);
        _record(c, deployerKey);

        console.log("hasher    %s", address(hasher));
        console.log("verifier  %s", address(verifier));
        console.log("pool      %s", address(pool));
        console.log("registry  %s", address(registry));
        console.log("owner     %s", c.owner);
    }

    function _config(uint256 deployerKey) internal view returns (Config memory c) {
        if (bytes(vm.envOr("RPC_URL", string(""))).length == 0) revert("RPC_URL is not set");
        string memory auditorFile = vm.envOr("AUDITOR_FILE", string(""));
        if (bytes(auditorFile).length == 0) revert("AUDITOR_FILE is not set");
        string memory auditorJson = vm.readFile(auditorFile);

        c.rootHistorySize = uint32(vm.envOr("ROOT_HISTORY_SIZE", uint256(1000)));
        c.auditorKey = [
            vm.parseJsonUint(auditorJson, ".pubKey[0]"),
            vm.parseJsonUint(auditorJson, ".pubKey[1]")
        ];
        c.maxDeposit = _ether(vm.envOr("MAX_DEPOSIT_ETH", string("0.1")));
        c.poolCap = _ether(vm.envOr("POOL_CAP_ETH", string("5")));
        c.owner = vm.envOr("OWNER", address(vm.addr(deployerKey)));
        c.ceremonyRecord = vm.envOr("CEREMONY_RECORD", string(""));
    }

    /// @dev "0.1" -> 100000000000000000. This forge-std has no parseEther.
    function _ether(string memory amount) internal pure returns (uint256 out) {
        bool dot = false;
        uint256 fraction = 0;
        uint256 digits = 0;
        for (uint256 i = 0; i < bytes(amount).length; i++) {
            uint8 c = uint8(bytes(amount)[i]);
            if (c == uint8(bytes1("."))) {
                if (dot) revert("amount: two dots");
                dot = true;
            } else if (c >= 48 && c <= 57) {
                if (dot) {
                    if (digits == 18) revert("amount: more than 18 decimals");
                    fraction = fraction * 10 + (c - 48);
                    digits++;
                } else {
                    out = out * 10 + (c - 48);
                }
            } else {
                revert("amount: not a number");
            }
        }
        return out * 1e18 + fraction * 10 ** (18 - digits);
    }

    /// @notice Reads back everything the deployment must have produced. A deployment that does
    ///         not match what the client expects is useless, so a mismatch stops the script.
    function _check(Config memory c) internal view {
        if (hasher.poseidon([uint256(1), uint256(2)]) != POSEIDON_1_2) revert("the hasher does not compute the circuit's Poseidon");
        if (pool.lastRoot() != EMPTY_ROOT_24) revert("the pool's empty root is not the one of depth 24");
        if (!pool.isKnownRoot(pool.lastRoot())) revert("the pool does not know its own root");
        if (pool.levels() != LEVELS) revert("tree depth");
        if (pool.rootHistorySize() != c.rootHistorySize) revert("root history size");
        uint256[2] memory key = pool.auditorKey();
        if (key[0] != c.auditorKey[0] || key[1] != c.auditorKey[1]) revert("auditor key");
        if (pool.owner() != c.owner) revert("owner");
        if (pool.maxDeposit() != c.maxDeposit || pool.poolCap() != c.poolCap) revert("limits");
        if (address(pool.verifier()) != address(verifier)) revert("the pool does not point at the verifier");
        if (address(pool.hasher()) != address(hasher)) revert("the pool does not point at the hasher");
        if (pool.totalHeld() != 0 || pool.nextIndex() != 0) revert("the pool is not empty");
    }

    function _record(Config memory c, uint256 deployerKey) internal {
        // Every serialize call adds one field to the object "deployment"; only the last call's
        // return value is the finished JSON.
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeString(obj, "rpc", vm.envOr("RPC_URL", string("")));
        vm.serializeAddress(obj, "deployer", vm.addr(deployerKey));
        vm.serializeAddress(obj, "owner", c.owner);
        vm.serializeAddress(obj, "hasher", address(hasher));
        vm.serializeAddress(obj, "verifier", address(verifier));
        vm.serializeAddress(obj, "pool", address(pool));
        vm.serializeAddress(obj, "registry", address(registry));
        vm.serializeUint(obj, "levels", LEVELS);
        vm.serializeUint(obj, "rootHistorySize", c.rootHistorySize);
        vm.serializeUint(obj, "maxDeposit", c.maxDeposit);
        vm.serializeUint(obj, "poolCap", c.poolCap);
        uint256[] memory auditorKey = new uint256[](2);
        auditorKey[0] = c.auditorKey[0];
        auditorKey[1] = c.auditorKey[1];
        vm.serializeUint(obj, "auditorKey", auditorKey);
        string memory json = vm.serializeString(obj, "ceremonyRecord", c.ceremonyRecord);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
