// Prints static facts about the compiled circuit and writes build/zk/circuit-info.json.
//
//   node scripts/circuit-report.mjs
import { circuitInfo } from "./lib/circuit-info.mjs";

const info = circuitInfo();
const { publicSignals, unusedWires, ...rest } = info;
console.log(JSON.stringify(rest, null, 2));
console.log("public signals and how many constraints use each:");
for (const s of publicSignals) console.log(`  [${String(s.index).padStart(2)}] ${s.label.padEnd(26)} ${s.constraints}`);
console.log("wires no constraint uses:", unusedWires.length ? unusedWires : "none");
