import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  adapterCatalog,
  loadAdapter,
  loadAdapterModule
} from "../src/gateway/adapters/registry.js";
import { runAdapterConformance } from "../src/gateway/adapters/conformance.js";
import {
  instantiateAdapter,
  validateAdapterConfig,
  validateAdapterManifest
} from "../src/gateway/adapters/sdk.js";
import {
  GLOBAL_TAG_REQUIREMENT,
  regulatoryProfile
} from "../src/gateway/adapters/regulatory-regions.js";

test("adapter registry loads and normalizes the built-in simulator", async () => {
  const adapter = await loadAdapter("simulate");
  const reads = [];
  for await (const read of adapter.reads()) reads.push(read);
  await adapter.close();
  assert.equal(reads.length, 5);
  assert.match(reads[0].epc, /^[0-9A-F]{24}$/);
  assert.equal(typeof reads[0].eventId, "string");
  assert.equal(adapter.manifest.apiVersion, 1);
});

test("stdin bridge adapts JSON Lines from serial or vendor bridge processes", async () => {
  const input = Readable.from([
    '{"epc":"aa aa aa aa 00 00 00 01","rssi":-42,"antenna":2}\n'
  ]);
  const adapter = await loadAdapter("stdin", { input });
  const reads = [];
  for await (const read of adapter.reads()) reads.push(read);
  await adapter.close();
  assert.equal(reads[0].epc, "AAAAAAAA00000001");
  assert.equal(reads[0].rssi, -42);
  assert.equal(reads[0].antenna, 2);
});

test("adapter conformance verifies manifest, normalized reads and health", async () => {
  const module = await loadAdapterModule("simulate");
  const report = await runAdapterConformance(module);
  assert.equal(report.passed, true);
  assert.equal(report.adapterId, "simulate");
  assert.equal(report.reads, 5);
  assert.deepEqual(
    report.checks.map((check) => check.name),
    ["manifest", "configuration", "instantiation", "normalized_reads", "health_contract"]
  );
});

test("adapter SDK rejects incompatible manifests and invalid configuration", () => {
  assert.throws(() => validateAdapterManifest({
    id: "vendor-reader",
    name: "Vendor Reader",
    version: "1.0.0",
    apiVersion: 99,
    transports: ["vendor-sdk"]
  }), /Unsupported adapter API/);
  assert.throws(() => validateAdapterConfig({
    required: ["host"],
    additionalProperties: false,
    properties: { host: { type: "string" } }
  }, { host: 123 }), /must be string/);
});

test("adapter catalog exposes every supported integration family", async () => {
  const catalog = await adapterCatalog();
  assert.deepEqual(catalog.builtIns.map((item) => item.id), ["rru9809usb", "simulate", "stdin"]);
  assert.deepEqual(catalog.families.map((item) => item.family), [
    "llrp",
    "mqtt",
    "http",
    "serial-usb",
    "android-sdk",
    "vendor-sdk"
  ]);
});

test("RF-emitting adapters require an explicit supported regulatory region", async () => {
  const module = {
    manifest: {
      id: "test-rf-reader",
      name: "Test RF Reader",
      version: "1.0.0",
      apiVersion: 1,
      transports: ["vendor-sdk"],
      rf: { emitsRf: true, supportedRegions: ["FCC_US"] }
    },
    configSchema: {
      required: ["regulatoryRegion"],
      properties: {
        regulatoryRegion: { type: "string", enum: ["FCC_US"] }
      },
      additionalProperties: false
    },
    async createAdapter() {
      return {
        async *reads() {
          yield { epc: "AAAAAAAA00000001" };
        },
        health() {
          return { readerConnected: true, lastError: null };
        }
      };
    }
  };
  await assert.rejects(() => instantiateAdapter(module), /Missing adapter config/);
  const adapter = await instantiateAdapter(module, {
    config: { regulatoryRegion: "FCC_US" }
  });
  assert.deepEqual(adapter.regulatoryProfile.frequencyMHz, { min: 902, max: 928 });
  await adapter.close();
  assert.equal(regulatoryProfile("FCC_US").authority, "FCC Part 15");
  assert.deepEqual(GLOBAL_TAG_REQUIREMENT.tagFrequencyMHz, { min: 860, max: 960 });
});
