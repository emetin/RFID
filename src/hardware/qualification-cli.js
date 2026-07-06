import { readFileSync, writeFileSync } from "node:fs";
import {
  qualifyReaderCapture,
  qualifyWriterVerification
} from "./qualification.js";

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on line ${index + 1}: ${error.message}`);
      }
    });
}

const command = process.argv[2];
let report;

if (command === "reader") {
  const configPath = process.argv[3];
  const capturePath = process.argv[4];
  if (!configPath || !capturePath) {
    throw new Error(
      "Usage: node src/hardware/qualification-cli.js reader <config.json> <capture.jsonl> [report.json]"
    );
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  report = qualifyReaderCapture({
    expectedEpcs: config.expectedEpcs ?? [],
    reads: readJsonLines(capturePath),
    thresholds: config.thresholds ?? {}
  });
} else if (command === "writer") {
  const verificationPath = process.argv[3];
  if (!verificationPath) {
    throw new Error(
      "Usage: node src/hardware/qualification-cli.js writer <verification.jsonl> [report.json]"
    );
  }
  report = qualifyWriterVerification(readJsonLines(verificationPath));
} else {
  throw new Error("Command must be reader or writer");
}

const output = `${JSON.stringify(report, null, 2)}\n`;
const outputPath = command === "reader" ? process.argv[5] : process.argv[4];
if (outputPath) writeFileSync(outputPath, output, "utf8");
console.log(output);
process.exitCode = report.passed ? 0 : 2;
