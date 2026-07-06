import test from "node:test";
import assert from "node:assert/strict";
import { calculatePackaging } from "../src/core/packaging.js";
import { parseAssetCsv, parseProductCsv } from "../src/core/csv.js";
import { InventoryStore } from "../src/core/inventory-store.js";

test("calculates pallets, boxes and loose units from item-level RFID counts", () => {
  assert.deepEqual(calculatePackaging(485, 24, 20), {
    units: 485,
    unitsPerBox: 24,
    boxesPerPallet: 20,
    unitsPerPallet: 480,
    fullPallets: 1,
    fullBoxes: 0,
    looseUnits: 5,
    boxEquivalent: 20.208,
    palletEquivalent: 1.01
  });
});

test("imports quoted product CSV values", () => {
  const [product] = parseProductCsv(
    'sku,name,category,units_per_box,boxes_per_pallet,size,color\n' +
    'BT-001,"Bath Towel, White",Towels,24,20,27x54,White\n'
  );
  assert.equal(product.name, "Bath Towel, White");
  assert.equal(product.unitsPerBox, 24);
});

test("normalizes EPC asset CSV values", () => {
  const [asset] = parseAssetCsv("epc,sku,tid\n30 34 ab cd,BT-001,E28011\n");
  assert.deepEqual(asset, { epc: "3034ABCD", sku: "BT-001", tid: "E28011" });
});

test("registered EPCs produce SKU packaging summaries and unknown tags stay visible", () => {
  const store = new InventoryStore();
  store.upsertProducts("hotel-a", [{
    sku: "BT-001",
    name: "Bath Towel",
    unitsPerBox: 2,
    boxesPerPallet: 2
  }]);
  store.registerAssets("hotel-a", [
    { epc: "AAAAAAAA00000001", sku: "BT-001" },
    { epc: "AAAAAAAA00000002", sku: "BT-001" },
    { epc: "AAAAAAAA00000003", sku: "BT-001" },
    { epc: "AAAAAAAA00000004", sku: "BT-001" },
    { epc: "AAAAAAAA00000005", sku: "BT-001" }
  ]);
  store.ingest({
    tenantId: "hotel-a",
    readerId: "reader-1",
    facilityId: "hotel-1",
    zoneId: "receiving",
    events: [
      ...Array.from({ length: 5 }, (_, index) => ({
        eventId: `known-${index}`,
        epc: `AAAAAAAA0000000${index + 1}`,
        observedAt: "2026-07-01T12:00:00.000Z"
      })),
      { eventId: "unknown", epc: "BBBBBBBB00000001", observedAt: "2026-07-01T12:00:00.000Z" }
    ]
  });

  const summary = store.summaryFor("hotel-a");
  assert.equal(summary.uniqueUnits, 6);
  assert.equal(summary.unknownUnits, 1);
  assert.equal(summary.lines[0].fullPallets, 1);
  assert.equal(summary.lines[0].looseUnits, 1);
});

test("unattended zone changes remain pending until a second consistent read", () => {
  const store = new InventoryStore();
  const base = {
    tenantId: "hotel-a",
    readerId: "reader-1",
    facilityId: "hotel-1"
  };
  store.ingest({
    ...base,
    zoneId: "linen-room",
    events: [{
      eventId: "initial",
      epc: "AAAAAAAA00000999",
      observedAt: "2026-07-01T12:00:00.000Z"
    }]
  });
  store.ingest({
    ...base,
    zoneId: "laundry-out",
    events: [{
      eventId: "candidate-1",
      epc: "AAAAAAAA00000999",
      observedAt: "2026-07-01T12:10:00.000Z"
    }]
  });

  assert.equal(store.inventoryFor("hotel-a")[0].zoneId, "linen-room");
  assert.equal(store.pendingMovementsFor("hotel-a")[0].observations, 1);

  store.ingest({
    ...base,
    zoneId: "laundry-out",
    events: [{
      eventId: "candidate-2",
      epc: "AAAAAAAA00000999",
      observedAt: "2026-07-01T12:10:05.000Z"
    }]
  });

  assert.equal(store.inventoryFor("hotel-a")[0].zoneId, "laundry-out");
  assert.equal(store.pendingMovementsFor("hotel-a").length, 0);
  assert.equal(store.movementsFor("hotel-a").length, 2);
});

test("raw read retention supports dry-run and bounded deletion without removing inventory", () => {
  const store = new InventoryStore();
  const common = {
    tenantId: "hotel-a",
    readerId: "reader-1",
    facilityId: "hotel-1",
    zoneId: "receiving"
  };
  const oldEvent = {
    eventId: "old-read",
    epc: "AAAAAAAA00000801",
    observedAt: "2026-01-01T10:00:00.000Z"
  };
  store.ingest({
    ...common,
    events: [oldEvent],
    receivedAt: "2026-01-01T10:00:01.000Z"
  });
  store.ingest({
    ...common,
    events: [{
      eventId: "recent-read",
      epc: "AAAAAAAA00000802",
      observedAt: "2026-07-01T10:00:00.000Z"
    }],
    receivedAt: "2026-07-01T10:00:01.000Z"
  });

  const dryRun = store.readEventRetention("hotel-a", {
    before: "2026-06-01T00:00:00.000Z",
    limit: 100,
    dryRun: true
  });
  assert.equal(dryRun.totalReadEvents, 2);
  assert.equal(dryRun.eligible, 1);
  assert.equal(dryRun.deleted, 0);

  const executed = store.readEventRetention("hotel-a", {
    before: "2026-06-01T00:00:00.000Z",
    limit: 100,
    dryRun: false
  });
  assert.equal(executed.deleted, 1);
  assert.equal(store.inventoryFor("hotel-a").length, 2);
  assert.equal(store.ingest({
    ...common,
    events: [oldEvent],
    receivedAt: "2026-07-02T10:00:00.000Z"
  }).accepted, 1);
  assert.equal(store.ingest({
    ...common,
    events: [{
      eventId: "recent-read",
      epc: "AAAAAAAA00000802",
      observedAt: "2026-07-01T10:00:00.000Z"
    }]
  }).duplicates, 1);
});

test("unknown EPC reads create one resolvable tenant exception case", () => {
  const store = new InventoryStore();
  const common = {
    tenantId: "hotel-a",
    readerId: "reader-1",
    facilityId: "hotel-1",
    zoneId: "receiving"
  };
  for (const eventId of ["unknown-1", "unknown-2"]) {
    store.ingest({
      ...common,
      events: [{
        eventId,
        epc: "AAAAAAAA00000888",
        observedAt: "2026-07-02T12:00:00.000Z"
      }]
    });
  }
  const cases = store.exceptionsFor("hotel-a", { status: "open" });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].exceptionType, "unknown_asset");

  const resolved = store.resolveException("hotel-a", cases[0].caseId, {
    resolution: "quarantined",
    actorId: "operator-1"
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "operator-1");
  assert.equal(store.exceptionsFor("other-hotel").length, 0);
  assert.equal(
    store.integrationOutboxFor("hotel-a")
      .some((event) => event.eventType === "exception.resolved"),
    true
  );
});

test("asset lifecycle enforces transitions and separates available inventory", () => {
  const store = new InventoryStore();
  const epc = "AAAAAAAA00000777";
  store.upsertProducts("hotel-a", [{
    sku: "BT-001",
    name: "Bath Towel",
    unitsPerBox: 2,
    boxesPerPallet: 2
  }]);
  store.registerAssets("hotel-a", [{ epc, sku: "BT-001" }]);
  store.ingest({
    tenantId: "hotel-a",
    readerId: "reader-1",
    facilityId: "hotel-1",
    zoneId: "linen-room",
    events: [{ eventId: "lifecycle-read", epc, observedAt: "2026-07-02T13:00:00.000Z" }]
  });

  const quarantined = store.updateAssetStatus("hotel-a", epc, {
    status: "quarantined",
    reason: "Visible stain",
    actorId: "operator-1"
  });
  assert.equal(quarantined.changed, true);
  assert.equal(store.inventoryFor("hotel-a")[0].assetStatus, "quarantined");
  const summary = store.summaryFor("hotel-a");
  assert.equal(summary.uniqueUnits, 1);
  assert.equal(summary.availableUnits, 0);
  assert.equal(summary.statusCounts.quarantined, 1);

  store.updateAssetStatus("hotel-a", epc, {
    status: "retired",
    reason: "Failed quality inspection",
    actorId: "hotel-admin"
  });
  assert.throws(
    () => store.updateAssetStatus("hotel-a", epc, {
      status: "active",
      reason: "Invalid reactivation",
      actorId: "hotel-admin"
    }),
    /cannot change/
  );
  assert.equal(store.assetLifecycleFor("hotel-a", epc).length, 3);
  assert.equal(
    store.integrationOutboxFor("hotel-a")
      .filter((event) => event.eventType === "asset.status_changed").length,
    2
  );
});

test("Gateway health becomes offline after the heartbeat deadline", () => {
  const store = new InventoryStore();
  const receivedAt = "2026-07-01T18:00:00.000Z";
  store.recordGatewayHealth({
    tenantId: "hotel-a",
    readerId: "reader-1",
    adapter: "llrp",
    gatewayVersion: "0.1.0",
    readerConnected: true,
    queueDepth: 0,
    heartbeatAt: receivedAt,
    receivedAt
  });
  store.recordGatewayHealth({
    tenantId: "hotel-a",
    readerId: "reader-1",
    adapter: "llrp",
    gatewayVersion: "0.0.9",
    readerConnected: false,
    queueDepth: 99,
    heartbeatAt: "2026-07-01T17:59:00.000Z",
    receivedAt: "2026-07-01T18:00:10.000Z"
  });
  assert.equal(store.gatewayHealthFor("hotel-a")[0].queueDepth, 0);
  assert.equal(
    store.gatewayHealthFor("hotel-a", {
      now: Date.parse("2026-07-01T18:01:00.000Z")
    })[0].status,
    "online"
  );
  assert.equal(
    store.gatewayHealthFor("hotel-a", {
      now: Date.parse("2026-07-01T18:01:31.000Z")
    })[0].status,
    "offline"
  );
});

test("operator can confirm or dismiss a pending RFID movement", () => {
  const store = new InventoryStore();
  const common = {
    tenantId: "hotel-a",
    readerId: "reader-1",
    facilityId: "hotel-1",
    epc: "AAAAAAAA00000888"
  };
  store.ingest({
    ...common,
    zoneId: "receiving",
    events: [{
      eventId: "resolution-initial",
      epc: common.epc,
      observedAt: "2026-07-02T17:00:00.000Z"
    }]
  });
  store.ingest({
    ...common,
    zoneId: "laundry",
    events: [{
      eventId: "resolution-pending",
      epc: common.epc,
      observedAt: "2026-07-02T17:01:00.000Z"
    }]
  });
  const confirmed = store.resolvePendingMovement("hotel-a", common.epc, {
    action: "confirm",
    actorId: "operator-1"
  });
  assert.equal(confirmed.movement.resolution, "operator_confirmed");
  assert.equal(store.inventoryFor("hotel-a")[0].zoneId, "laundry");

  store.ingest({
    ...common,
    zoneId: "linen-room",
    events: [{
      eventId: "resolution-dismiss",
      epc: common.epc,
      observedAt: "2026-07-02T17:02:00.000Z"
    }]
  });
  const dismissed = store.resolvePendingMovement("hotel-a", common.epc, {
    action: "dismiss",
    actorId: "operator-1"
  });
  assert.equal(dismissed.movement, null);
  assert.equal(store.inventoryFor("hotel-a")[0].zoneId, "laundry");
});
