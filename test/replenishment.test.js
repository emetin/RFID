import test from "node:test";
import assert from "node:assert/strict";
import { InventoryStore } from "../src/core/inventory-store.js";
import { SqliteStore } from "../src/core/sqlite-store.js";
import { createApp } from "../src/api/app.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateStock, saveStockPolicy, transitionRequest, dispatchStockRequest } from "../src/core/hotel-operations.js";

const principal = { role: "chain_admin", actorId: "globaltex" };
const epcs = ["3034257BF7194E40000000A1", "3034257BF7194E40000000A2"];
const product = { sku: "TOWEL", name: "Bath towel", unitsPerBox: 1, boxesPerPallet: 1 };
async function setup(store) {
  for (const tenantId of ["globaltex", "hotel-a"]) {
    await store.upsertFacility(tenantId, { facilityId: "main", name: tenantId, facilityType: "hotel" });
    await store.upsertZone(tenantId, { facilityId: "main", zoneId: "receiving", name: "Receiving", zoneType: "receiving" });
    await store.upsertProducts(tenantId, [product]);
  }
  await store.registerAssets("globaltex", epcs.map(epc => ({ epc, sku: "TOWEL" })));
  await store.ingest({ tenantId: "globaltex", readerId: "supplier", facilityId: "main", zoneId: "receiving",
    events: epcs.map((epc, i) => ({ epc, eventId: `source-${i}`, observedAt: new Date().toISOString() })) });
  await store.updateOperations("hotel-a", s => saveStockPolicy(s, { sku: "TOWEL", minimum: 2, target: 2, automatic: true }, "manager"));
  const state = await evaluateStock(store, "hotel-a");
  return state.requests[0];
}
for (const backend of ["memory", "sqlite"]) {
  test(`${backend}: request dispatch is retry-safe, reserves EPCs and completes only after full receiving`, async () => {
    const store = backend === "sqlite" ? new SqliteStore(":memory:") : new InventoryStore();
    try {
      const request = await setup(store);
      const dispatch = { tenantId: "hotel-a", requestId: request.requestId, supplierTenantId: "globaltex", destinationFacilityId: "main", epcs, actorId: "globaltex" };
      await assert.rejects(() => dispatchStockRequest(store, dispatch), /Approve/);
      await store.updateOperations("hotel-a", s => transitionRequest(s, request.requestId, "approved", principal));
      await assert.rejects(() => dispatchStockRequest(store, { ...dispatch, epcs: [epcs[0]] }), /exactly 2/);
      await assert.rejects(() => dispatchStockRequest(store, { ...dispatch, epcs: [epcs[0], epcs[0]] }), /duplicate/);
      await assert.rejects(() => dispatchStockRequest(store, { ...dispatch, destinationFacilityId: "other-hotel" }), /receiving facility/);
      const [a, b] = await Promise.all([dispatchStockRequest(store, dispatch), dispatchStockRequest(store, dispatch)]);
      assert.equal(a.shipment.shipmentId, b.shipment.shipmentId);
      assert.equal((await store.shipmentsFor("globaltex")).length, 1);
      assert.equal(a.request.status, "shipped");
      assert.equal((await store.operationsFor("hotel-a")).requests[0].history.filter(h => h.status === "shipped").length, 1);
      await assert.rejects(async () => store.createShipment({ tenantId: "globaltex", customerTenantId: "hotel-a", destinationFacilityId: "main", epcs, shipmentId: "duplicate-package" }), /reserved/);
      await assert.rejects(async () => store.updateOperations("hotel-a", s => transitionRequest(s, request.requestId, "fulfilled", principal)), /verified receiving/);
      const first = await store.startSession({ tenantId: "hotel-a", facilityId: "main", zoneId: "receiving", type: "receiving" });
      await store.ingest({ tenantId: "hotel-a", readerId: "hotel", facilityId: "main", zoneId: "receiving", sessionId: first.sessionId,
        events: [{ epc: epcs[0], eventId: "receive-partial", observedAt: new Date().toISOString() }] });
      const partial = await store.reconcileShipment({ tenantId: "hotel-a", shipmentId: a.shipment.shipmentId, sessionId: first.sessionId, accept: true });
      assert.equal(partial.shipment.status, "partially_received");
      let state = await evaluateStock(store, "hotel-a");
      assert.equal(state.requests[0].status, "shipped");
      assert.equal(state.requests[0].receivedQuantity, 1);
      const second = await store.startSession({ tenantId: "hotel-a", facilityId: "main", zoneId: "receiving", type: "receiving" });
      await store.ingest({ tenantId: "hotel-a", readerId: "hotel", facilityId: "main", zoneId: "receiving", sessionId: second.sessionId,
        events: [{ epc: epcs[1], eventId: "receive-remaining", observedAt: new Date().toISOString() }] });
      const completed = await store.reconcileShipment({ tenantId: "hotel-a", shipmentId: a.shipment.shipmentId, sessionId: second.sessionId, accept: true });
      assert.equal(completed.missingCount, 0, "previously accepted items are not missing in a later delivery");
      assert.equal((await store.exceptionsFor("hotel-a", { status: "open", exceptionType: "shipment_missing" })).length, 0);
      state = await evaluateStock(store, "hotel-a");
      assert.equal(state.requests[0].status, "fulfilled");
      assert.equal(state.requests[0].receivedQuantity, 2);
      assert.equal(state.policies[0].available, 2);
      assert.equal(state.requests.length, 1);
      assert.equal((await dispatchStockRequest(store, dispatch)).request.status, "fulfilled", "retry after custody transfer is safe");
    } finally { await store.close?.(); }
  });
}

test("request dispatch rejects a mismatched SKU or damaged source item without changing the request", async () => {
  const store = new InventoryStore();
  const request = await setup(store);
  store.updateOperations("hotel-a", s => transitionRequest(s, request.requestId, "approved", principal));
  store.updateAssetStatus("globaltex", epcs[0], { status: "damaged", reason: "damaged", actorId: "operator" });
  const input = { tenantId: "hotel-a", requestId: request.requestId, supplierTenantId: "globaltex", destinationFacilityId: "main", epcs, actorId: "globaltex" };
  await assert.rejects(() => dispatchStockRequest(store, input), /available TOWEL/);
  assert.equal(store.operationsFor("hotel-a").requests[0].dispatch, undefined);
  assert.equal(store.shipmentsFor("globaltex").length, 0);
});

test("SQLite recovers a linked shipment after restart without creating a second package", async () => {
  const folder = mkdtempSync(join(tmpdir(), "rfid-replenishment-"));
  const file = join(folder, "test.db");
  let store = new SqliteStore(file);
  try {
    const request = await setup(store);
    store.updateOperations("hotel-a", s => transitionRequest(s, request.requestId, "approved", principal));
    const dispatch = { tenantId: "hotel-a", requestId: request.requestId, supplierTenantId: "globaltex", destinationFacilityId: "main", epcs, actorId: "globaltex" };
    const first = await dispatchStockRequest(store, dispatch);
    // Model interruption after package creation, before the request status was persisted.
    store.updateOperations("hotel-a", s => { const r = s.requests[0]; r.status = "approved"; delete r.shipmentId; r.history = r.history.filter(h => h.status !== "shipped"); });
    store.close(); store = new SqliteStore(file);
    await evaluateStock(store, "hotel-a");
    assert.equal(store.operationsFor("hotel-a").requests[0].status, "shipped");
    assert.equal((await dispatchStockRequest(store, dispatch)).shipment.shipmentId, first.shipment.shipmentId);
    assert.equal(store.shipmentsFor("globaltex").length, 1);
    const second = { ...request, requestId: "second-request", status: "approved", history: [] };
    store.updateOperations("hotel-a", s => s.requests.push(second));
    await assert.rejects(() => dispatchStockRequest(store, { ...dispatch, requestId: second.requestId }), /reserved/);
    const after = store.operationsFor("hotel-a").requests.find(r => r.requestId === second.requestId);
    assert.equal(after.status, "approved");
    assert.equal(after.dispatch, undefined, "failed reservation is released");
  } finally { store.close(); rmSync(folder, { recursive: true }); }
});

test("accept-delivery API automatically completes the linked request and prevents tenant spoofing", async () => {
  const store = new InventoryStore();
  const request = await setup(store);
  store.updateOperations("hotel-a", s => transitionRequest(s, request.requestId, "approved", principal));
  const server = createApp({ store, credentials: { reader: { tenantId: "globaltex", readerId: "r", secret: "secret" } },
    admin: { identities: { secret: { actorId: "globaltex", role: "chain_admin", tenantIds: ["globaltex", "hotel-a"] }, hotel: { actorId: "hotel-manager", role: "hotel_admin", tenantIds: ["hotel-a"] } } } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, tenant = "hotel-a") => fetch(base + path, { method: "POST", headers: {
    authorization: "Basic " + Buffer.from(path.includes("/stock/requests/") ? "admin:secret" : "admin:hotel").toString("base64"), "x-tenant-id": tenant, "content-type": "application/json"
  }, body: JSON.stringify(body) });
  try {
    const dispatched = await post(`/v1/admin/stock/requests/${request.requestId}/dispatch`, { supplierTenantId: "globaltex", destinationFacilityId: "main", epcs });
    assert.equal(dispatched.status, 200);
    const { shipment } = await dispatched.json();
    const sessionResponse = await post("/v1/admin/sessions", { tenantId: "other-hotel", facilityId: "main", zoneId: "receiving", type: "receiving" });
    const session = await sessionResponse.json();
    assert.equal(session.tenantId, "hotel-a");
    store.ingest({ tenantId: "hotel-a", readerId: "r", facilityId: "main", zoneId: "receiving", sessionId: session.sessionId,
      events: epcs.map((epc, i) => ({ epc, eventId: `http-receive-${i}`, observedAt: new Date().toISOString() })) });
    const accepted = await post(`/v1/admin/shipments/${shipment.shipmentId}/accept`, { sessionId: session.sessionId });
    assert.equal(accepted.status, 200);
    assert.equal(store.operationsFor("hotel-a").requests[0].status, "fulfilled");
  } finally { await new Promise(resolve => server.close(resolve)); }
});
