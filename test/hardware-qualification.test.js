import test from "node:test";
import assert from "node:assert/strict";
import {
  qualifyReaderCapture,
  qualifyWriterVerification
} from "../src/hardware/qualification.js";

test("reader qualification reports read rate, antennas and missing EPCs", () => {
  const report = qualifyReaderCapture({
    expectedEpcs: ["AAAAAAAA00000001", "AAAAAAAA00000002"],
    reads: [
      {
        eventId: "event-1",
        epc: "AAAAAAAA00000001",
        observedAt: "2026-07-02T15:00:00.000Z",
        rssi: -45,
        antenna: 1
      },
      {
        eventId: "event-2",
        epc: "AAAAAAAA00000001",
        observedAt: "2026-07-02T15:00:01.000Z",
        rssi: -43,
        antenna: 2
      }
    ],
    thresholds: { minReadRate: 1, minReadsPerTag: 1 }
  });
  assert.equal(report.passed, false);
  assert.equal(report.readRate, 0.5);
  assert.deepEqual(report.missing, ["AAAAAAAA00000002"]);
  assert.deepEqual(report.readsByAntenna, { "1": 1, "2": 1 });
  assert.equal(report.rssi.average, -44);
});

test("reader qualification passes complete repeated reads with stable event IDs", () => {
  const report = qualifyReaderCapture({
    expectedEpcs: ["AAAAAAAA00000001", "AAAAAAAA00000002"],
    reads: [
      ["event-1", "AAAAAAAA00000001", 1],
      ["event-2", "AAAAAAAA00000001", 2],
      ["event-3", "AAAAAAAA00000002", 1],
      ["event-4", "AAAAAAAA00000002", 2]
    ].map(([eventId, epc, antenna], index) => ({
      eventId,
      epc,
      antenna,
      observedAt: `2026-07-02T15:00:0${index}.000Z`
    })),
    thresholds: { minReadRate: 1, minReadsPerTag: 2 }
  });
  assert.equal(report.passed, true);
  assert.equal(report.validObservations, 4);
  assert.deepEqual(report.duplicateEventIds, []);
});

test("writer qualification requires successful EPC read-back and optional TID match", () => {
  const report = qualifyWriterVerification([
    {
      expectedEpc: "AAAAAAAA00000001",
      readEpc: "AAAAAAAA00000001",
      expectedTid: "E28001",
      readTid: "e28001",
      writeStatus: "verified",
      locked: true
    },
    {
      expectedEpc: "AAAAAAAA00000002",
      readEpc: "AAAAAAAA00000003",
      writeStatus: "success"
    }
  ]);
  assert.equal(report.passed, false);
  assert.equal(report.verified, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].tidMatches, true);
  assert.equal(report.results[1].epcMatches, false);
});
