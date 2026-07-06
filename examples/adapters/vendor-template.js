export const manifest = {
  id: "replace-vendor-model",
  name: "Replace Vendor Model",
  version: "0.1.0",
  apiVersion: 1,
  transports: ["vendor-sdk"],
  deviceTypes: ["fixed_reader"],
  rf: {
    emitsRf: true,
    supportedRegions: ["FCC_US", "ETSI_TR"]
  }
};

export const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["host", "regulatoryRegion"],
  properties: {
    host: { type: "string" },
    port: { type: "integer", minimum: 1 },
    regulatoryRegion: { type: "string", enum: ["FCC_US", "ETSI_TR"] }
  }
};

export async function createAdapter({ config, now }) {
  let connected = false;
  return {
    async *reads() {
      // Apply config.regulatoryRegion through the vendor SDK before enabling RF.
      // Connect with the vendor SDK using config.host/config.port.
      connected = true;
      // Convert each vendor message to this canonical shape:
      yield {
        eventId: "replace-with-stable-vendor-or-generated-id",
        epc: "3034257BF7194E4000000001",
        observedAt: now(),
        rssi: -45,
        antenna: 1
      };
    },
    health() {
      return { readerConnected: connected, lastError: null };
    },
    async close() {
      connected = false;
    }
  };
}
