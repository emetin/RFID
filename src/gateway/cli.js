import { loadAdapter } from "./adapters/registry.js";
import { runGatewayAdapter } from "./runner.js";

function parseJson(name, value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

const gateway = {
  apiUrl: process.env.API_URL ?? "http://127.0.0.1:8080",
  deviceKey: process.env.DEVICE_KEY ?? "local-reader",
  deviceSecret: process.env.DEVICE_SECRET ?? "local-device-secret",
  facilityId: process.env.FACILITY_ID ?? "hotel-local-1",
  zoneId: process.env.ZONE_ID ?? "receiving",
  sessionId: process.env.SESSION_ID || undefined
};
for (const [key, value] of Object.entries(gateway)) {
  if (!value && key !== "sessionId") throw new Error(`Missing Gateway config: ${key}`);
}

const specifier = process.argv[2] ?? process.env.ADAPTER;
if (!specifier) {
  console.error("Usage: node src/gateway/cli.js <simulate|stdin|adapter-module-path>");
  process.exit(1);
}

try {
  const adapterConfig = parseJson("ADAPTER_CONFIG", process.env.ADAPTER_CONFIG);
  if (process.env.REGULATORY_REGION && adapterConfig.regulatoryRegion == null) {
    adapterConfig.regulatoryRegion = process.env.REGULATORY_REGION;
  }
  const adapter = await loadAdapter(specifier, {
    config: adapterConfig,
    input: process.stdin
  });
  const result = await runGatewayAdapter({
    adapter,
    gateway,
    queuePath: process.env.EDGE_QUEUE_PATH ?? "data/runtime/edge-queue.db",
    encryptionKey: process.env.EDGE_QUEUE_KEY,
    gatewayVersion: process.env.GATEWAY_VERSION ?? "0.1.0"
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
