import { createInterface } from "node:readline";

export const manifest = {
  id: "stdin",
  name: "JSON Lines standard input",
  version: "1.0.0",
  apiVersion: 1,
  transports: ["stdin", "serial_bridge", "vendor_bridge"],
  deviceTypes: ["fixed_reader", "handheld", "desktop_reader", "desktop_writer"]
};

export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    regulatoryRegion: { type: "string" }
  }
};

export async function createAdapter({ input }) {
  return {
    async *reads() {
      const lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.trim()) yield JSON.parse(line);
      }
    },
    health() {
      return { readerConnected: true, lastError: null };
    }
  };
}
