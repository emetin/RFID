import {
  instantiateAdapter,
  validateAdapterConfig,
  validateAdapterModule
} from "./sdk.js";

export async function runAdapterConformance(module, {
  config = {},
  input,
  maxReads = 100
} = {}) {
  const checks = [];
  const check = (name, operation) => {
    try {
      const value = operation();
      checks.push({ name, passed: true });
      return value;
    } catch (error) {
      checks.push({ name, passed: false, error: String(error.message ?? error) });
      return null;
    }
  };
  check("manifest", () => validateAdapterModule(module));
  check("configuration", () => validateAdapterConfig(module.configSchema, config));
  if (checks.some((item) => !item.passed)) {
    return { passed: false, adapterId: module.manifest?.id ?? null, reads: 0, checks };
  }

  let adapter;
  try {
    adapter = await instantiateAdapter(module, { config, input });
    checks.push({ name: "instantiation", passed: true });
  } catch (error) {
    checks.push({ name: "instantiation", passed: false, error: String(error.message ?? error) });
    return { passed: false, adapterId: module.manifest.id, reads: 0, checks };
  }

  let reads = 0;
  const eventIds = new Set();
  try {
    for await (const read of adapter.reads()) {
      reads += 1;
      if (eventIds.has(read.eventId)) throw new Error(`Duplicate eventId: ${read.eventId}`);
      eventIds.add(read.eventId);
      if (reads >= maxReads) break;
    }
    checks.push({ name: "normalized_reads", passed: reads > 0, ...(reads ? {} : { error: "No reads produced" }) });
    const health = adapter.health();
    checks.push({
      name: "health_contract",
      passed: typeof health.readerConnected === "boolean",
      ...(typeof health.readerConnected === "boolean" ? {} : { error: "readerConnected must be boolean" })
    });
  } catch (error) {
    checks.push({ name: "normalized_reads", passed: false, error: String(error.message ?? error) });
  } finally {
    await adapter.close();
  }
  return {
    passed: checks.every((item) => item.passed),
    adapterId: module.manifest.id,
    adapterVersion: module.manifest.version,
    reads,
    checks
  };
}
