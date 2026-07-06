import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresDatabase } from "../src/core/postgres-database.js";
import { PostgresStore } from "../src/core/postgres-store.js";
import { createApp } from "../src/api/app.js";
import { sendReads } from "../src/gateway/client.js";

const connectionString = process.env.TEST_POSTGRES_URL;
const randomEpc = () => randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase();

test("live PostgresStore supports the core RFID platform contract", {
  skip: !connectionString
}, async () => {
  const database = new PostgresDatabase({ connectionString });
  const store = new PostgresStore(database);
  const tenantId = `pg-hotel-${randomUUID().slice(0, 8)}`;
  const epc = randomEpc();
  try {
    await store.upsertFacility(tenantId, {
      facilityId: "hotel-1",
      name: "Postgres Hotel",
      facilityType: "hotel"
    });
    await store.upsertZone(tenantId, {
      zoneId: "receiving",
      facilityId: "hotel-1",
      name: "Receiving",
      zoneType: "receiving"
    });
    await store.upsertReader(tenantId, {
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      name: "Reader One",
      adapter: "simulate"
    });
    await store.upsertProducts(tenantId, [{
      sku: "BT-001",
      name: "Bath Towel",
      unitsPerBox: 24,
      boxesPerPallet: 20
    }]);
    await store.registerAssets(tenantId, [{ epc, sku: "BT-001" }]);
    const session = await store.startSession({
      tenantId,
      facilityId: "hotel-1",
      zoneId: "receiving",
      type: "receiving"
    });
    const ingestion = await store.ingest({
      tenantId,
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      sessionId: session.sessionId,
      events: [{
        eventId: "postgres-read-1",
        epc,
        observedAt: "2026-07-02T16:00:00.000Z",
        rssi: -44,
        antenna: 1
      }],
      receivedAt: "2026-07-02T16:00:01.000Z"
    });
    assert.deepEqual(ingestion, { accepted: 1, duplicates: 0, unknownAssets: 0 });
    assert.equal((await store.inventoryFor(tenantId))[0].sku, "BT-001");
    assert.equal((await store.summaryFor(tenantId)).lines[0].units, 1);
    assert.equal((await store.sessionsFor(tenantId))[0].uniqueEpcs, 1);
    assert.equal((await store.integrationOutboxFor(tenantId)).length, 1);
    await store.updateAssetStatus(tenantId, epc, {
      status: "damaged",
      reason: "Live PostgreSQL lifecycle test",
      actorId: "pg-operator"
    });
    assert.equal((await store.inventoryFor(tenantId))[0].assetStatus, "damaged");
    assert.equal((await store.summaryFor(tenantId)).availableUnits, 0);
    assert.equal((await store.assetLifecycleFor(tenantId, epc)).length, 2);
    await store.updateAssetStatus(tenantId, epc, {
      status: "active",
      reason: "Repair completed",
      actorId: "pg-operator"
    });
    const retentionPreview = await store.readEventRetention(tenantId, {
      before: "2026-07-02T16:30:00.000Z",
      dryRun: true
    });
    assert.equal(retentionPreview.eligible, 1);
    const retention = await store.readEventRetention(tenantId, {
      before: "2026-07-02T16:30:00.000Z",
      dryRun: false
    });
    assert.equal(retention.deleted, 1);
    assert.equal((await store.inventoryFor(tenantId)).length, 1);

    await store.upsertZone(tenantId, {
      zoneId: "laundry",
      facilityId: "hotel-1",
      name: "Laundry",
      zoneType: "laundry"
    });
    await store.upsertReader(tenantId, {
      readerId: "reader-2",
      facilityId: "hotel-1",
      zoneId: "laundry",
      name: "Reader Two",
      adapter: "simulate"
    });
    await store.ingest({
      tenantId,
      readerId: "reader-2",
      facilityId: "hotel-1",
      zoneId: "laundry",
      events: [{
        eventId: "postgres-pending-1",
        epc,
        observedAt: "2026-07-02T16:01:00.000Z"
      }]
    });
    assert.equal((await store.pendingMovementsFor(tenantId)).length, 1);
    await store.resolvePendingMovement(tenantId, epc, {
      action: "confirm",
      actorId: "pg-operator"
    });
    assert.equal((await store.inventoryFor(tenantId))[0].zoneId, "laundry");

    await store.recordGatewayHealth({
      tenantId,
      readerId: "reader-1",
      adapter: "simulate",
      gatewayVersion: "0.1.0",
      readerConnected: true,
      queueDepth: 0,
      heartbeatAt: new Date().toISOString()
    });
    assert.equal((await store.gatewayHealthFor(tenantId))[0].status, "online");

    await store.recordAudit({
      tenantId,
      actorId: "pg-admin",
      actorRole: "hotel_admin",
      action: "postgres.contract",
      entityType: "test"
    });
    assert.equal((await store.auditFor(tenantId))[0].actorId, "pg-admin");
    assert.equal((await store.evaluateOperationalAlerts(tenantId)).length, 0);

    const unknownEpc = randomEpc();
    await store.ingest({
      tenantId,
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      events: [{
        eventId: randomUUID(),
        epc: unknownEpc,
        observedAt: "2026-07-02T17:00:00.000Z"
      }]
    });
    const exception = (await store.exceptionsFor(tenantId, {
      status: "open",
      exceptionType: "unknown_asset"
    }))[0];
    assert.equal(exception.epc, unknownEpc);
    const resolved = await store.resolveException(tenantId, exception.caseId, {
      resolution: "quarantined",
      actorId: "pg-operator"
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolvedBy, "pg-operator");

    const adminUser = await store.createAdminUser({
      username: `manager-${randomUUID().slice(0, 8)}@example.com`,
      displayName: "Postgres Manager",
      passwordHash: "scrypt:test:hash",
      role: "hotel_admin",
      tenantIds: [tenantId],
      defaultTenantId: tenantId
    });
    assert.equal((await store.adminUserById(adminUser.userId)).role, "hotel_admin");
    await store.updateAdminUser(adminUser.userId, { role: "viewer" });
    assert.equal((await store.adminUserByUsername(adminUser.username)).role, "viewer");
  } finally {
    await store.close();
  }
});

test("live PostgresStore transfers shipment custody to a hotel tenant", {
  skip: !connectionString
}, async () => {
  const database = new PostgresDatabase({ connectionString });
  const store = new PostgresStore(database);
  const suffix = randomUUID().slice(0, 8);
  const supplier = `pg-supplier-${suffix}`;
  const customer = `pg-customer-${suffix}`;
  const epc = randomEpc();
  try {
    await store.upsertProducts(supplier, [{
      sku: "ST-001",
      name: "Spa Towel",
      unitsPerBox: 20,
      boxesPerPallet: 10
    }]);
    await store.registerAssets(supplier, [{ epc, sku: "ST-001" }]);
    await store.upsertFacility(customer, {
      facilityId: "hotel-1",
      name: "Destination Hotel",
      facilityType: "hotel"
    });
    await store.upsertZone(customer, {
      zoneId: "receiving",
      facilityId: "hotel-1",
      name: "Receiving",
      zoneType: "receiving"
    });
    await store.upsertReader(customer, {
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      name: "Receiving Reader",
      adapter: "simulate"
    });
    const shipment = await store.createShipment({
      tenantId: supplier,
      shipmentId: randomUUID(),
      customerTenantId: customer,
      destinationFacilityId: "hotel-1",
      epcs: [epc]
    });
    const session = await store.startSession({
      tenantId: customer,
      facilityId: "hotel-1",
      zoneId: "receiving",
      type: "receiving"
    });
    await store.ingest({
      tenantId: customer,
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      sessionId: session.sessionId,
      events: [{
        eventId: randomUUID(),
        epc,
        observedAt: "2026-07-02T16:30:00.000Z"
      }]
    });
    const accepted = await store.reconcileShipment({
      tenantId: customer,
      shipmentId: shipment.shipmentId,
      sessionId: session.sessionId,
      accept: true
    });
    assert.equal(accepted.shipment.status, "received");
    assert.equal(accepted.shipment.acceptedAssetCount, 1);
    assert.equal((await store.inventoryFor(customer))[0].sku, "ST-001");
    assert.equal(
      (await store.custodyHistoryFor(customer, { epc }))[0].changeType,
      "shipment_received"
    );
    assert.notEqual(
      (await store.custodyHistoryFor(supplier, { epc }))[0].validTo,
      null
    );
  } finally {
    await store.close();
  }
});

test("HTTP API runs end to end on PostgresStore", {
  skip: !connectionString
}, async () => {
  const database = new PostgresDatabase({ connectionString });
  const store = new PostgresStore(database);
  const tenantId = `pg-api-${randomUUID().slice(0, 8)}`;
  const credential = {
    tenantId,
    readerId: "reader-1",
    secret: "postgres-reader-secret"
  };
  const server = createApp({
    credentials: { "postgres-reader": credential },
    admin: { token: "postgres-admin", tenantId },
    store,
    requireProvisionedReaders: true
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from("admin:postgres-admin").toString("base64")}`;
  const post = (path, body) => fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    assert.equal((await post("/v1/admin/facilities", {
      facilityId: "hotel-1",
      name: "API Hotel",
      facilityType: "hotel"
    })).status, 200);
    assert.equal((await post("/v1/admin/zones", {
      zoneId: "receiving",
      facilityId: "hotel-1",
      name: "Receiving",
      zoneType: "receiving"
    })).status, 200);
    assert.equal((await post("/v1/admin/readers", {
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      name: "Reader",
      adapter: "simulate"
    })).status, 200);
    const ingestion = await sendReads({
      apiUrl,
      deviceKey: "postgres-reader",
      deviceSecret: credential.secret,
      facilityId: "hotel-1",
      zoneId: "receiving",
      reads: [{ epc: randomEpc() }]
    });
    assert.equal(ingestion.accepted, 1);
    const summary = await fetch(`${apiUrl}/v1/admin/summary`, {
      headers: { authorization }
    });
    assert.equal(summary.status, 200);
    assert.equal((await summary.json()).uniqueUnits, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
});

test("chain summary aggregates only allowlisted Postgres tenants", {
  skip: !connectionString
}, async () => {
  const database = new PostgresDatabase({ connectionString });
  const store = new PostgresStore(database);
  const tenants = [
    `pg-chain-a-${randomUUID().slice(0, 8)}`,
    `pg-chain-b-${randomUUID().slice(0, 8)}`
  ];
  const epcs = [randomEpc(), randomEpc()];
  let server;
  try {
    for (let index = 0; index < tenants.length; index += 1) {
      const tenantId = tenants[index];
      await store.upsertFacility(tenantId, {
        facilityId: "hotel-1",
        name: `Chain Hotel ${index + 1}`,
        facilityType: "hotel"
      });
      await store.upsertZone(tenantId, {
        zoneId: "linen-room",
        facilityId: "hotel-1",
        name: "Linen Room",
        zoneType: "storage"
      });
      await store.upsertReader(tenantId, {
        readerId: "reader-1",
        facilityId: "hotel-1",
        zoneId: "linen-room",
        name: "Reader One",
        adapter: "simulate"
      });
      await store.upsertProducts(tenantId, [{
        sku: "BT-001",
        name: "Bath Towel",
        unitsPerBox: 2,
        boxesPerPallet: 2
      }]);
      await store.registerAssets(tenantId, [{ epc: epcs[index], sku: "BT-001" }]);
      await store.ingest({
        tenantId,
        readerId: "reader-1",
        facilityId: "hotel-1",
        zoneId: "linen-room",
        events: [{
          eventId: randomUUID(),
          epc: epcs[index],
          observedAt: "2026-07-02T19:00:00.000Z"
        }]
      });
    }

    server = createApp({
      credentials: {
        dummy: {
          tenantId: tenants[0],
          readerId: "reader-1",
          secret: "dummy-secret"
        }
      },
      admin: {
        identities: {
          "chain-secret": {
            actorId: "pg-chain-admin",
            role: "chain_admin",
            tenantIds: tenants,
            defaultTenantId: tenants[0]
          }
        }
      },
      store
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const authorization = `Basic ${Buffer.from("admin:chain-secret").toString("base64")}`;
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/admin/chain/summary`,
      { headers: { authorization } }
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.tenantCount, 2);
    assert.equal(result.totals.uniqueUnits, 2);
    assert.equal(result.lines[0].tenantCount, 2);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
});
