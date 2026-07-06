import { readFileSync } from "node:fs";
import { loadAdapterModule } from "./registry.js";
import { runAdapterConformance } from "./conformance.js";

const specifier = process.argv[2];
if (!specifier) {
  console.error("Usage: npm run adapter:test -- <adapter-id-or-module> [config.json]");
  process.exit(1);
}
const config = process.argv[3]
  ? JSON.parse(readFileSync(process.argv[3], "utf8"))
  : (process.env.ADAPTER_CONFIG ? JSON.parse(process.env.ADAPTER_CONFIG) : {});
const module = await loadAdapterModule(specifier);
const report = await runAdapterConformance(module, { config, input: process.stdin });
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
