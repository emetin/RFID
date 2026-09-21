import { SerialPort } from "serialport";

const CRC_PRESET = 0xffff;
const CRC_POLYNOMIAL = 0x8408;

export const manifest = {
  id: "rru9809usb",
  name: "Royal Ray RRU9809USB-L",
  version: "1.0.0",
  apiVersion: 1,
  transports: ["serial-usb"],
  deviceTypes: ["desktop_reader", "desktop_writer"],
  rf: {
    emitsRf: true,
    supportedRegions: ["ETSI_TR"]
  }
};

export const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["port", "regulatoryRegion"],
  properties: {
    port: { type: "string" },
    baudRate: { type: "integer", minimum: 1 },
    scanCount: { type: "integer", minimum: 1 },
    scanDelayMs: { type: "integer", minimum: 0 },
    responseTimeoutMs: { type: "integer", minimum: 100 },
    regulatoryRegion: { type: "string", enum: ["ETSI_TR"] }
  }
};

export function crc16(bytes) {
  let value = CRC_PRESET;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ CRC_POLYNOMIAL : value >>> 1;
    }
  }
  return value;
}

export function commandPacket(command, data = [], address = 0xff) {
  const length = data.length + 4;
  const body = Buffer.from([length, address, command, ...data]);
  const checksum = crc16(body);
  return Buffer.concat([body, Buffer.from([checksum & 0xff, checksum >>> 8])]);
}

export function validateFrame(frame) {
  if (frame.length < 6 || frame.length !== frame[0] + 1) {
    throw new Error("RRU9809 returned an invalid frame length");
  }
  const body = frame.subarray(0, -2);
  const expected = crc16(body);
  const actual = frame.at(-2) | (frame.at(-1) << 8);
  if (actual !== expected) throw new Error("RRU9809 returned an invalid CRC");
  return frame;
}

export function parseInventoryFrame(frame) {
  validateFrame(frame);
  if (frame[2] !== 0x01) throw new Error("RRU9809 returned an unexpected command");
  if (frame[3] === 0xfb) return [];
  if (![0x01, 0x02, 0x03, 0x04].includes(frame[3])) {
    throw new Error(`RRU9809 inventory failed with status 0x${frame[3].toString(16).padStart(2, "0")}`);
  }
  const count = frame[4];
  const reads = [];
  let offset = 5;
  for (let index = 0; index < count; index += 1) {
    const epcLength = frame[offset];
    offset += 1;
    const end = offset + epcLength;
    if (!epcLength || end > frame.length - 2) {
      throw new Error("RRU9809 returned malformed EPC data");
    }
    reads.push({ epc: frame.subarray(offset, end).toString("hex").toUpperCase(), antenna: 1 });
    offset = end;
  }
  return reads;
}

function normalizeWritableEpc(value) {
  const epc = String(value ?? "").replace(/\s/g, "").toUpperCase();
  if (!/^[0-9A-F]{8,60}$/.test(epc) || epc.length % 4 !== 0) {
    throw new Error("EPC must contain 2 to 15 complete hexadecimal words");
  }
  return epc;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function openPort(port) {
  return new Promise((resolve, reject) => {
    port.open((error) => error ? reject(error) : resolve());
  });
}

function closePort(port) {
  return new Promise((resolve, reject) => {
    if (!port.isOpen) return resolve();
    port.close((error) => error ? reject(error) : resolve());
  });
}

function writePacket(port, packet) {
  return new Promise((resolve, reject) => {
    port.write(packet, (writeError) => {
      if (writeError) return reject(writeError);
      port.drain((drainError) => drainError ? reject(drainError) : resolve());
    });
  });
}

function readFrame(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      port.off("data", onData);
      port.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!buffered.length) return;
      const frameLength = buffered[0] + 1;
      if (buffered.length < frameLength) return;
      cleanup();
      resolve(buffered.subarray(0, frameLength));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`RRU9809 response timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    port.on("data", onData);
    port.on("error", onError);
  });
}

async function request(port, packet, timeoutMs) {
  const response = readFrame(port, timeoutMs);
  await writePacket(port, packet);
  return response;
}

async function verifyReader(port, timeoutMs) {
  const info = validateFrame(await request(port, commandPacket(0x21), timeoutMs));
  if (info[2] !== 0x21 || info[3] !== 0x00 || (info[7] & 0x02) === 0) {
    throw new Error("Connected serial device is not an EPC Gen2 RRU9809 reader");
  }
  return {
    firmware: `${info[4]}.${info[5]}`,
    readerType: info[6],
    protocols: info[7],
    powerDbm: info[10]
  };
}

export async function scanRru9809({
  port: path,
  baudRate = 57600,
  scanCount = 1,
  scanDelayMs = 250,
  responseTimeoutMs = 5000
}) {
  const adapter = await createAdapter({
    config: { port: path, baudRate, scanCount, scanDelayMs, responseTimeoutMs }
  });
  try {
    const reads = [];
    for await (const read of adapter.reads()) reads.push(read);
    return reads;
  } finally {
    await adapter.close();
  }
}

export async function writeRru9809Epc({
  port: path,
  epc,
  baudRate = 57600,
  responseTimeoutMs = 5000
}) {
  const normalizedEpc = normalizeWritableEpc(epc);
  const serial = new SerialPort({
    path,
    baudRate,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    autoOpen: false
  });
  await openPort(serial);
  try {
    await verifyReader(serial, responseTimeoutMs);
    const before = parseInventoryFrame(await request(
      serial,
      commandPacket(0x01),
      responseTimeoutMs
    ));
    if (before.length !== 1) {
      throw new Error(before.length
        ? "Place exactly one tag on the writer"
        : "No writable tag was detected");
    }
    const bytes = Buffer.from(normalizedEpc, "hex");
    const response = validateFrame(await request(
      serial,
      commandPacket(0x04, [bytes.length / 2, 0, 0, 0, 0, ...bytes]),
      responseTimeoutMs
    ));
    if (response[2] !== 0x04 || response[3] !== 0x00) {
      throw new Error(`RRU9809 write failed with status 0x${response[3].toString(16).padStart(2, "0")}`);
    }
    await delay(250);
    const after = parseInventoryFrame(await request(
      serial,
      commandPacket(0x01),
      responseTimeoutMs
    ));
    if (after.length !== 1 || after[0].epc !== normalizedEpc) {
      throw new Error("EPC write completed but read-back verification failed");
    }
    return { previousEpc: before[0].epc, epc: normalizedEpc, verified: true };
  } finally {
    await closePort(serial);
  }
}

export async function createAdapter({ config }) {
  const port = new SerialPort({
    path: config.port,
    baudRate: config.baudRate ?? 57600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    autoOpen: false
  });
  const state = { readerConnected: false, lastError: null };
  await openPort(port);
  state.readerConnected = true;

  try {
    await verifyReader(port, config.responseTimeoutMs ?? 5000);
  } catch (error) {
    state.readerConnected = false;
    state.lastError = String(error.message ?? error);
    await closePort(port);
    throw error;
  }

  return {
    async *reads() {
      const scanCount = config.scanCount ?? 1;
      for (let scan = 0; scan < scanCount; scan += 1) {
        try {
          const frame = await request(
            port,
            commandPacket(0x01),
            config.responseTimeoutMs ?? 5000
          );
          for (const read of parseInventoryFrame(frame)) yield read;
          state.lastError = null;
        } catch (error) {
          state.lastError = String(error.message ?? error);
          throw error;
        }
        if (scan + 1 < scanCount) await delay(config.scanDelayMs ?? 250);
      }
    },
    health() {
      return { ...state, readerConnected: state.readerConnected && port.isOpen };
    },
    async close() {
      state.readerConnected = false;
      await closePort(port);
    }
  };
}
