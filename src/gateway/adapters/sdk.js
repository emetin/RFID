import { normalizeRead } from "../client.js";
import { validateRegulatoryConfig } from "./regulatory-regions.js";

export const ADAPTER_API_VERSION = 1;

function typeMatches(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

export function validateAdapterManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("Adapter manifest is required");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.id ?? "")) {
    throw new Error("Adapter manifest id is invalid");
  }
  if (typeof manifest.name !== "string" || !manifest.name) {
    throw new Error("Adapter manifest name is required");
  }
  if (manifest.apiVersion !== ADAPTER_API_VERSION) {
    throw new Error(`Unsupported adapter API version: ${manifest.apiVersion}`);
  }
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("Adapter version is required");
  }
  if (!Array.isArray(manifest.transports) || manifest.transports.length === 0) {
    throw new Error("Adapter transports are required");
  }
  return manifest;
}

export function validateAdapterConfig(schema = {}, config = {}) {
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Adapter config must be an object");
  }
  for (const required of schema.required ?? []) {
    if (config[required] == null || config[required] === "") {
      throw new Error(`Missing adapter config: ${required}`);
    }
  }
  for (const [key, value] of Object.entries(config)) {
    const definition = schema.properties?.[key];
    if (!definition) {
      if (schema.additionalProperties === false) {
        throw new Error(`Unsupported adapter config: ${key}`);
      }
      continue;
    }
    if (definition.type && !typeMatches(value, definition.type)) {
      throw new Error(`Adapter config ${key} must be ${definition.type}`);
    }
    if (definition.enum && !definition.enum.includes(value)) {
      throw new Error(`Adapter config ${key} has an unsupported value`);
    }
    if (definition.minimum != null && value < definition.minimum) {
      throw new Error(`Adapter config ${key} is below its minimum`);
    }
  }
  return config;
}

export function validateAdapterModule(module) {
  validateAdapterManifest(module.manifest);
  if (typeof module.createAdapter !== "function") {
    throw new Error("Adapter must export createAdapter()");
  }
  return module;
}

export function normalizeAdapterRead(read, observedAt) {
  const normalized = normalizeRead(read, observedAt);
  if (!/^[0-9A-F]{8,96}$/.test(normalized.epc)) {
    throw new Error(`Adapter produced invalid EPC: ${normalized.epc}`);
  }
  if (!normalized.eventId || typeof normalized.eventId !== "string") {
    throw new Error("Adapter produced invalid eventId");
  }
  if (!Number.isFinite(Date.parse(normalized.observedAt))) {
    throw new Error("Adapter produced invalid observedAt");
  }
  if (normalized.rssi != null && !Number.isFinite(normalized.rssi)) {
    throw new Error("Adapter produced invalid RSSI");
  }
  if (normalized.antenna != null && !Number.isInteger(normalized.antenna)) {
    throw new Error("Adapter produced invalid antenna");
  }
  return normalized;
}

export async function instantiateAdapter(module, {
  config = {},
  input = process.stdin,
  now = () => new Date().toISOString()
} = {}) {
  validateAdapterModule(module);
  validateAdapterConfig(module.configSchema, config);
  const regulatoryProfile = validateRegulatoryConfig(module.manifest, config);
  const adapter = await module.createAdapter({ config, input, now });
  if (!adapter || typeof adapter.reads !== "function") {
    throw new Error("createAdapter() must return an object with reads()");
  }
  return {
    manifest: module.manifest,
    regulatoryProfile,
    async *reads() {
      for await (const read of adapter.reads()) {
        yield normalizeAdapterRead(read, now());
      }
    },
    health() {
      return adapter.health?.() ?? { readerConnected: true, lastError: null };
    },
    async close() {
      await adapter.close?.();
    }
  };
}
