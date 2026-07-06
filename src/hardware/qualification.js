const EPC_PATTERN = /^[0-9A-F]{8,96}$/;

function normalizedEpc(value) {
  return String(value ?? "").replace(/\s/g, "").toUpperCase();
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor((sorted.length - 1) * ratio), sorted.length - 1)];
}

export function qualifyReaderCapture({
  expectedEpcs,
  reads,
  thresholds = {}
}) {
  const expected = new Set(expectedEpcs.map(normalizedEpc));
  const seen = new Set();
  const eventIds = new Set();
  const duplicateEventIds = new Set();
  const invalid = [];
  const rssiValues = [];
  const readsByAntenna = new Map();
  const observationsByEpc = new Map();
  let earliest = null;
  let latest = null;

  for (const [index, read] of reads.entries()) {
    const epc = normalizedEpc(read.epc);
    const observedAt = Date.parse(read.observedAt);
    if (!EPC_PATTERN.test(epc) || !Number.isFinite(observedAt)) {
      invalid.push({ index, epc, reason: "invalid_epc_or_timestamp" });
      continue;
    }
    if (read.eventId) {
      if (eventIds.has(read.eventId)) duplicateEventIds.add(read.eventId);
      eventIds.add(read.eventId);
    }
    seen.add(epc);
    observationsByEpc.set(epc, (observationsByEpc.get(epc) ?? 0) + 1);
    if (Number.isFinite(Number(read.rssi))) rssiValues.push(Number(read.rssi));
    const antenna = read.antenna == null ? "unknown" : String(read.antenna);
    readsByAntenna.set(antenna, (readsByAntenna.get(antenna) ?? 0) + 1);
    earliest = earliest == null ? observedAt : Math.min(earliest, observedAt);
    latest = latest == null ? observedAt : Math.max(latest, observedAt);
  }

  const missing = [...expected].filter((epc) => !seen.has(epc)).sort();
  const unexpected = [...seen].filter((epc) => !expected.has(epc)).sort();
  const observedExpected = [...expected].filter((epc) => seen.has(epc)).length;
  const readRate = expected.size === 0 ? 0 : observedExpected / expected.size;
  const minReadsPerTag = thresholds.minReadsPerTag ?? 1;
  const underRead = [...expected]
    .filter((epc) => (observationsByEpc.get(epc) ?? 0) < minReadsPerTag)
    .map((epc) => ({ epc, observations: observationsByEpc.get(epc) ?? 0 }));
  const appliedThresholds = {
    minReadRate: thresholds.minReadRate ?? 0.99,
    maxUnexpected: thresholds.maxUnexpected ?? 0,
    maxInvalid: thresholds.maxInvalid ?? 0,
    maxDuplicateEventIds: thresholds.maxDuplicateEventIds ?? 0,
    minReadsPerTag
  };
  const criteria = {
    readRate: readRate >= appliedThresholds.minReadRate,
    unexpected: unexpected.length <= appliedThresholds.maxUnexpected,
    invalid: invalid.length <= appliedThresholds.maxInvalid,
    duplicateEventIds:
      duplicateEventIds.size <= appliedThresholds.maxDuplicateEventIds,
    readsPerTag: underRead.length === 0
  };

  return {
    passed: Object.values(criteria).every(Boolean),
    criteria,
    thresholds: appliedThresholds,
    expectedUniqueEpcs: expected.size,
    observedExpectedEpcs: observedExpected,
    observedUniqueEpcs: seen.size,
    validObservations: [...observationsByEpc.values()].reduce((sum, count) => sum + count, 0),
    readRate: Number(readRate.toFixed(6)),
    missing,
    unexpected,
    underRead,
    invalid,
    duplicateEventIds: [...duplicateEventIds].sort(),
    durationMs: earliest == null ? 0 : latest - earliest,
    readsByAntenna: Object.fromEntries(
      [...readsByAntenna.entries()].sort(([a], [b]) => a.localeCompare(b))
    ),
    rssi: {
      samples: rssiValues.length,
      min: rssiValues.length ? Math.min(...rssiValues) : null,
      max: rssiValues.length ? Math.max(...rssiValues) : null,
      average: rssiValues.length
        ? Number((rssiValues.reduce((sum, value) => sum + value, 0) / rssiValues.length).toFixed(3))
        : null,
      p50: percentile(rssiValues, 0.5),
      p95: percentile(rssiValues, 0.95)
    }
  };
}

export function qualifyWriterVerification(records) {
  const results = records.map((record, index) => {
    const expectedEpc = normalizedEpc(record.expectedEpc);
    const readEpc = normalizedEpc(record.readEpc);
    const epcMatches = EPC_PATTERN.test(expectedEpc) && expectedEpc === readEpc;
    const tidMatches = record.expectedTid == null ||
      String(record.expectedTid).toUpperCase() === String(record.readTid ?? "").toUpperCase();
    const writeSucceeded = ["success", "verified"].includes(
      String(record.writeStatus ?? "").toLowerCase()
    );
    const passed = epcMatches && tidMatches && writeSucceeded;
    return {
      index,
      expectedEpc,
      readEpc,
      epcMatches,
      tidMatches,
      writeSucceeded,
      locked: Boolean(record.locked),
      passed
    };
  });
  const passed = results.filter((result) => result.passed).length;
  return {
    passed: passed === results.length && results.length > 0,
    total: results.length,
    verified: passed,
    failed: results.length - passed,
    results
  };
}
