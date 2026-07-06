export const manifest = {
  id: "simulate",
  name: "Reference simulator",
  version: "1.0.0",
  apiVersion: 1,
  transports: ["memory"],
  deviceTypes: ["fixed_reader", "handheld", "desktop_writer"]
};

export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reads: { type: "array" },
    regulatoryRegion: { type: "string" }
  }
};

const DEFAULT_READS = [
  { epc: "3034257BF7194E4000000001", rssi: -43.2, antenna: 1 },
  { epc: "3034257BF7194E4000000002", rssi: -49.8, antenna: 1 },
  { epc: "3034257BF7194E4000000003", rssi: -51.1, antenna: 2 },
  { epc: "3034257BF7194E4000000004", rssi: -52.4, antenna: 2 },
  { epc: "3034257BF7194E4000000005", rssi: -48.6, antenna: 2 }
];

export async function createAdapter({ config }) {
  const reads = config.reads ?? DEFAULT_READS;
  return {
    async *reads() {
      for (const read of reads) yield read;
    },
    health() {
      return { readerConnected: true, lastError: null };
    }
  };
}
