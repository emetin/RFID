import test from "node:test";
import assert from "node:assert/strict";
import {
  commandPacket,
  crc16,
  parseInventoryFrame,
  validateFrame
} from "../src/gateway/adapters/rru9809usb.js";

test("RRU9809 builds the documented get-reader-information packet", () => {
  assert.deepEqual([...commandPacket(0x21)], [0x04, 0xff, 0x21, 0x19, 0x95]);
  assert.equal(crc16(Buffer.from([0x04, 0xff, 0x21])), 0x9519);
});

test("RRU9809 parses a captured EPC Gen2 inventory response", () => {
  const captured = Buffer.from(
    "13000101010C475458260720000000000001D6C1",
    "hex"
  );
  assert.equal(validateFrame(captured), captured);
  assert.deepEqual(parseInventoryFrame(captured), [{
    epc: "475458260720000000000001",
    antenna: 1
  }]);
});

test("RRU9809 treats status FB as a valid empty scan", () => {
  assert.deepEqual(
    parseInventoryFrame(Buffer.from("050001FBF23D", "hex")),
    []
  );
});
