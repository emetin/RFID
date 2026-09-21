import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/sqlite-store.js";

test("SQLite persists customer API idempotency and rate limits across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "globaltex-rfid-api-"));
  const path = join(directory, "rfid.db");
  const identity = {
    tenantId: "hotel-a", clientId: "erp-a", method: "POST",
    path: "/v1/customer/catalog", idempotencyKey: "sync-001"
  };
  try {
    const first = new SqliteStore(path);
    assert.deepEqual(first.consumeCustomerApiRateLimit("erp-a", 100, 2), { allowed: true, count: 1 });
    assert.deepEqual(first.customerApiIdempotencyPut({
      ...identity, response: { imported: 4 }
    }), { imported: 4 });
    first.close();

    const reopened = new SqliteStore(path);
    assert.deepEqual(reopened.consumeCustomerApiRateLimit("erp-a", 100, 2), { allowed: true, count: 2 });
    assert.deepEqual(reopened.customerApiIdempotencyGet(identity), { imported: 4 });
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite preserves products, EPC inventory and sessions after reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "globaltex-rfid-"));
  const path = join(directory, "rfid.db");
  const tenantId = "hotel-persistent";
  const event = {
    eventId: "persistent-event-1",
    epc: "3034257BF7194E4000000101",
    observedAt: "2026-07-01T14:00:00.000Z",
    rssi: -44,
    antenna: 1
  };

  try {
    const first = new SqliteStore(path);
    first.upsertProducts(tenantId, [{
      sku: "BT-001",
      name: "Bath Towel",
      unitsPerBox: 24,
      boxesPerPallet: 20
    }]);
    first.registerAssets(tenantId, [{ epc: event.epc, sku: "BT-001" }]);
    const session = first.startSession({
      tenantId,
      facilityId: "hotel-1",
      zoneId: "receiving",
      type: "receiving"
    });
    assert.deepEqual(first.ingest({
      tenantId,
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      sessionId: session.sessionId,
      events: [event]
    }), { accepted: 1, duplicates: 0, unknownAssets: 0 });
    first.completeSession(tenantId, session.sessionId);
    first.recordGatewayHealth({
      tenantId,
      readerId: "reader-1",
      adapter: "simulate",
      gatewayVersion: "0.1.0",
      readerConnected: true,
      queueDepth: 0,
      heartbeatAt: "2026-07-01T14:01:00.000Z",
      receivedAt: "2026-07-01T14:01:00.000Z"
    });
    first.recordAudit({
      tenantId,
      actorId: "hotel-admin",
      actorRole: "hotel_admin",
      action: "POST /v1/admin/sessions",
      entityType: "api_route",
      details: { reference: "PO-1" },
      createdAt: "2026-07-01T14:02:00.000Z"
    });
    first.close();

    const reopened = new SqliteStore(path);
    assert.equal(reopened.productsFor(tenantId).length, 1);
    assert.equal(reopened.inventoryFor(tenantId).length, 1);
    assert.equal(reopened.sessionsFor(tenantId)[0].uniqueEpcs, 1);
    assert.equal(reopened.summaryFor(tenantId).lines[0].units, 1);
    assert.equal(reopened.integrationOutboxFor(tenantId).length, 1);
    assert.equal(
      reopened.gatewayHealthFor(tenantId, {
        now: Date.parse("2026-07-01T14:01:30.000Z")
      })[0].status,
      "online"
    );
    assert.equal(reopened.auditFor(tenantId)[0].actorId, "hotel-admin");
    assert.deepEqual(reopened.ingest({
      tenantId,
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      events: [event]
    }), { accepted: 0, duplicates: 1, unknownAssets: 0 });
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite persists shipment reconciliation and transfers EPC custody", () => {
  const database = new SqliteStore(":memory:");
  const supplier = "globaltex";
  const hotel = "hotel-chain-a";
  const expected = [
    "3034257BF7194E4000000301",
    "3034257BF7194E4000000302"
  ];
  try {
    database.upsertProducts(supplier, [{
      sku: "ST-001",
      name: "Spa Towel",
      unitsPerBox: 20,
      boxesPerPallet: 10
    }]);
    database.registerAssets(supplier, expected.map((epc) => ({ epc, sku: "ST-001" })));
    database.createShipment({
      tenantId: supplier,
      shipmentId: "shipment-sqlite-1",
      customerTenantId: hotel,
      destinationFacilityId: "hotel-1",
      epcs: expected
    });
    const session = database.startSession({
      tenantId: hotel,
      facilityId: "hotel-1",
      zoneId: "receiving",
      type: "receiving"
    });
    database.ingest({
      tenantId: hotel,
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      sessionId: session.sessionId,
      events: [{
        eventId: "shipment-read-1",
        epc: expected[0],
        observedAt: "2026-07-01T15:00:00.000Z"
      }]
    });

    const preview = database.reconcileShipment({
      tenantId: hotel,
      shipmentId: "shipment-sqlite-1",
      sessionId: session.sessionId
    });
    assert.equal(preview.receivedCount, 1);
    assert.deepEqual(preview.missing, [expected[1]]);

    const accepted = database.reconcileShipment({
      tenantId: hotel,
      shipmentId: "shipment-sqlite-1",
      sessionId: session.sessionId,
      accept: true
    });
    assert.equal(accepted.shipment.status, "partially_received");
    assert.equal(accepted.shipment.acceptedAssetCount, 1);
    assert.equal(database.inventoryFor(hotel)[0].sku, "ST-001");
    assert.equal(
      database.custodyHistoryFor(hotel, { epc: expected[0] })[0].changeType,
      "shipment_received"
    );
    assert.equal(
      database.assetLifecycleFor(hotel, expected[0])[0].reason,
      "custody_transfer"
    );
    assert.notEqual(
      database.custodyHistoryFor(supplier, { epc: expected[0] })[0].validTo,
      null
    );
    const openCases = database.exceptionsFor(hotel, { status: "open" });
    assert.equal(openCases.length, 1);
    assert.equal(openCases[0].exceptionType, "shipment_missing");
    assert.equal(openCases[0].epc, expected[1]);
    const resolvedUnknown = database.exceptionsFor(hotel, {
      status: "resolved",
      exceptionType: "unknown_asset"
    });
    assert.equal(resolvedUnknown.length, 1);
    assert.equal(resolvedUnknown[0].resolution, "corrected");
    assert.throws(
      () => database.registerAssets(hotel, [{ epc: expected[1], sku: "ST-001" }]),
      /already assigned to tenant/
    );
  } finally {
    database.close();
  }
});

test("SQLite keeps a zone change pending until movement evidence is confirmed", () => {
  const database = new SqliteStore(":memory:");
  const common = {
    tenantId: "hotel-a",
    readerId: "reader-1",
    facilityId: "hotel-1"
  };
  try {
    database.ingest({
      ...common,
      zoneId: "linen-room",
      events: [{
        eventId: "initial",
        epc: "3034257BF7194E4000000401",
        observedAt: "2026-07-01T16:00:00.000Z"
      }]
    });
    database.ingest({
      ...common,
      zoneId: "laundry-out",
      events: [{
        eventId: "candidate-1",
        epc: "3034257BF7194E4000000401",
        observedAt: "2026-07-01T16:05:00.000Z"
      }]
    });
    assert.equal(database.inventoryFor("hotel-a")[0].zoneId, "linen-room");
    assert.equal(database.pendingMovementsFor("hotel-a")[0].observations, 1);

    database.ingest({
      ...common,
      zoneId: "laundry-out",
      events: [{
        eventId: "candidate-2",
        epc: "3034257BF7194E4000000401",
        observedAt: "2026-07-01T16:05:04.000Z"
      }]
    });
    assert.equal(database.inventoryFor("hotel-a")[0].zoneId, "laundry-out");
    assert.equal(database.pendingMovementsFor("hotel-a").length, 0);
  } finally {
    database.close();
  }
});

test("SQLite purges only eligible raw reads in bounded batches", () => {
  const database = new SqliteStore(":memory:");
  const common = {
    tenantId: "hotel-a",
    readerId: "reader-1",
    facilityId: "hotel-1",
    zoneId: "receiving"
  };
  try {
    for (const [eventId, epc, receivedAt] of [
      ["old-1", "3034257BF7194E4000000501", "2026-01-01T00:00:00.000Z"],
      ["old-2", "3034257BF7194E4000000502", "2026-02-01T00:00:00.000Z"],
      ["new-1", "3034257BF7194E4000000503", "2026-07-01T00:00:00.000Z"]
    ]) {
      database.ingest({
        ...common,
        events: [{ eventId, epc, observedAt: receivedAt }],
        receivedAt
      });
    }
    const first = database.readEventRetention("hotel-a", {
      before: "2026-06-01T00:00:00.000Z",
      limit: 1,
      dryRun: false
    });
    assert.equal(first.eligible, 2);
    assert.equal(first.deleted, 1);
    assert.equal(database.inventoryFor("hotel-a").length, 3);

    const remaining = database.readEventRetention("hotel-a", {
      before: "2026-06-01T00:00:00.000Z",
      dryRun: true
    });
    assert.equal(remaining.totalReadEvents, 2);
    assert.equal(remaining.eligible, 1);
  } finally {
    database.close();
  }
});

test("SQLite persists asset status history and available inventory counts", () => {
  const database = new SqliteStore(":memory:");
  const epc = "3034257BF7194E4000000601";
  try {
    database.upsertProducts("hotel-a", [{
      sku: "BT-001",
      name: "Bath Towel",
      unitsPerBox: 2,
      boxesPerPallet: 2
    }]);
    database.registerAssets("hotel-a", [{ epc, sku: "BT-001" }]);
    database.ingest({
      tenantId: "hotel-a",
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "linen-room",
      events: [{
        eventId: "sqlite-lifecycle-read",
        epc,
        observedAt: "2026-07-02T14:00:00.000Z"
      }]
    });
    database.updateAssetStatus("hotel-a", epc, {
      status: "damaged",
      reason: "Torn edge",
      actorId: "operator-1"
    });
    assert.equal(database.inventoryFor("hotel-a")[0].assetStatus, "damaged");
    assert.equal(database.summaryFor("hotel-a").availableUnits, 0);
    assert.equal(database.summaryFor("hotel-a").statusCounts.damaged, 1);
    assert.equal(database.assetLifecycleFor("hotel-a", epc).length, 2);
  } finally {
    database.close();
  }
});

test("SQLite persists reader provisioning and rejects mismatched zones", () => {
  const database = new SqliteStore(":memory:");
  try {
    database.upsertFacility("hotel-a", {
      facilityId: "hotel-1",
      name: "Hotel One",
      facilityType: "hotel"
    });
    database.upsertZone("hotel-a", {
      zoneId: "receiving",
      facilityId: "hotel-1",
      name: "Receiving",
      zoneType: "receiving"
    });
    database.upsertReader("hotel-a", {
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      name: "Reader One",
      adapter: "llrp"
    });

    assert.deepEqual(database.validateReaderContext({
      tenantId: "hotel-a",
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      required: true
    }), { valid: true, reason: null });
    assert.deepEqual(database.validateReaderContext({
      tenantId: "hotel-a",
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "laundry",
      required: true
    }), { valid: false, reason: "reader_zone_mismatch" });
  } finally {
    database.close();
  }
});

test("SQLite persists managed admin users and hotel assignments", () => {
  const database = new SqliteStore(":memory:");
  try {
    const created = database.createAdminUser({
      username: "manager@example.com",
      displayName: "Hotel Manager",
      passwordHash: "scrypt:test:hash",
      role: "hotel_admin",
      tenantIds: ["hotel-a"],
      defaultTenantId: "hotel-a"
    });
    assert.equal(created.username, "manager@example.com");
    assert.equal("passwordHash" in created, false);
    const authenticated = database.adminUserByUsername("MANAGER@EXAMPLE.COM");
    assert.equal(authenticated.passwordHash, "scrypt:test:hash");
    assert.deepEqual(authenticated.tenantIds, ["hotel-a"]);
    database.updateAdminUser(created.userId, {
      tenantIds: ["hotel-a", "hotel-b"],
      defaultTenantId: "hotel-b"
    });
    assert.deepEqual(database.adminUserById(created.userId).tenantIds, ["hotel-a", "hotel-b"]);
  } finally {
    database.close();
  }
});

test("SQLite encoding orchestration allocates unique EPCs, coordinates stations and replaces failures", () => {
  const database = new SqliteStore(":memory:");
  try {
    database.upsertProducts("factory-a", [{
      sku: "TOWEL-1", name: "Towel", unitsPerBox: 1, boxesPerPallet: 1
    }]);
    const batch = database.createEncodingBatch("factory-a", { sku: "TOWEL-1", requestedQuantity: 2 });
    assert.equal(batch.queued, 2);

    const first = database.claimEncodingJob("factory-a", { stationId: "writer-a" });
    const second = database.claimEncodingJob("factory-a", { stationId: "writer-b" });
    assert.notEqual(first.jobId, second.jobId);
    assert.notEqual(first.epc, second.epc);
    assert.throws(() => database.finishEncodingJob("factory-a", {
      jobId: first.jobId, stationId: "writer-b", leaseToken: first.leaseToken,
      observedEpc: first.epc
    }), /lease is not owned/);

    const failed = database.finishEncodingJob("factory-a", {
      jobId: first.jobId, stationId: "writer-a", leaseToken: first.leaseToken,
      observedEpc: "000000000000000000000000"
    });
    assert.equal(failed.verified, false);
    assert.equal(failed.batch.failed, 1);
    assert.equal(failed.batch.queued, 1);

    database.finishEncodingJob("factory-a", {
      jobId: second.jobId, stationId: "writer-b", leaseToken: second.leaseToken,
      observedEpc: second.epc, tid: "E280TEST2"
    });
    const replacement = database.claimEncodingJob("factory-a", { stationId: "writer-c" });
    assert.notEqual(replacement.epc, first.epc);
    assert.notEqual(replacement.epc, second.epc);
    const completed = database.finishEncodingJob("factory-a", {
      jobId: replacement.jobId, stationId: "writer-c", leaseToken: replacement.leaseToken,
      observedEpc: replacement.epc, tid: "E280TEST3"
    });
    assert.equal(completed.batch.status, "completed");
    assert.equal(completed.batch.verified, 2);
    assert.equal(completed.batch.failed, 1);
  } finally {
    database.close();
  }
});

test("SQLite encoding leases recover after expiry and allocator survives restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "globaltex-rfid-encoding-"));
  const path = join(directory, "rfid.db");
  try {
    const firstStore = new SqliteStore(path);
    firstStore.upsertProducts("factory-a", [{
      sku: "SHEET-1", name: "Sheet", unitsPerBox: 1, boxesPerPallet: 1
    }]);
    firstStore.createEncodingBatch("factory-a", { sku: "SHEET-1", requestedQuantity: 1 });
    const firstClaim = firstStore.claimEncodingJob("factory-a", {
      stationId: "writer-a", now: "2026-07-21T10:00:00.000Z", leaseSeconds: 15
    });
    firstStore.close();

    const reopened = new SqliteStore(path);
    const recovered = reopened.claimEncodingJob("factory-a", {
      stationId: "writer-b", now: "2026-07-21T10:00:16.000Z", leaseSeconds: 15
    });
    assert.equal(recovered.jobId, firstClaim.jobId);
    assert.notEqual(recovered.leaseToken, firstClaim.leaseToken);
    assert.equal(recovered.attempts, 2);
    reopened.finishEncodingJob("factory-a", {
      jobId: recovered.jobId, stationId: "writer-b", leaseToken: recovered.leaseToken,
      observedEpc: recovered.epc, now: "2026-07-21T10:00:17.000Z"
    });
    const nextBatch = reopened.createEncodingBatch("factory-a", { sku: "SHEET-1", requestedQuantity: 1 });
    const next = reopened.claimEncodingJob("factory-a", { stationId: "writer-c" });
    assert.notEqual(next.epc, recovered.epc);
    assert.equal(next.batchId, nextBatch.batchId);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
