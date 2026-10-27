import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InventoryStore } from "../src/core/inventory-store.js";
import { SqliteStore } from "../src/core/sqlite-store.js";
import { evaluateStock, saveStockPolicy, transitionRequest, dispatchStockRequest } from "../src/core/hotel-operations.js";
import { createApp } from "../src/api/app.js";

const product = { sku: "TOWEL", name: "Banyo havlusu", unitsPerBox: 10, boxesPerPallet: 20 };
for (const backend of ["memory", "sqlite"]) {
  test(`${backend}: low stock creates one durable request, excludes damaged goods and rearms after recovery`, async () => {
    const store = backend === "sqlite" ? new SqliteStore(":memory:") : new InventoryStore();
    try {
      store.upsertProducts("hotel-a", [product]);
      const epcs = ["3034257BF7194E4000000001", "3034257BF7194E4000000002"];
      store.registerAssets("hotel-a", epcs.map(epc => ({ epc, sku: product.sku })));
      store.ingest({ tenantId: "hotel-a", readerId: "r", facilityId: "hotel", zoneId: "stock",
        events: epcs.map((epc, i) => ({ epc, eventId: `e${i}`, observedAt: new Date().toISOString() })) });
      await store.updateOperations("hotel-a", s => saveStockPolicy(s, { sku: "TOWEL", minimum: 3, target: 10, automatic: true }, "manager"));
      let state = await evaluateStock(store, "hotel-a");
      assert.equal(state.policies[0].available, 2);
      assert.equal(state.requests[0].quantity, 8);
      await Promise.all(Array.from({ length: 5 }, () => evaluateStock(store, "hotel-a")));
      assert.equal((await store.operationsFor("hotel-a")).requests.length, 1);
      await store.updateOperations("hotel-a", s => transitionRequest(s, state.requests[0].requestId, "cancelled", { role: "hotel_admin", actorId: "manager" }));
      await evaluateStock(store, "hotel-a");
      assert.equal((await store.operationsFor("hotel-a")).requests.length, 1, "cancellation does not cause immediate request spam");
      await store.updateOperations("hotel-a", s => saveStockPolicy(s, { sku: "TOWEL", minimum: 1, target: 10, automatic: true }, "manager"));
      await evaluateStock(store, "hotel-a");
      assert.equal((await store.operationsFor("hotel-a")).policies[0].triggered, false);
      await store.updateOperations("hotel-a", s => saveStockPolicy(s, { sku: "TOWEL", minimum: 3, target: 10, automatic: true }, "manager"));
      state = await evaluateStock(store, "hotel-a");
      assert.equal(state.requests.length, 2);
      store.updateAssetStatus("hotel-a", epcs[0], { status: "damaged", reason: "Test hasarlı ürün", actorId: "manager" });
      state = await evaluateStock(store, "hotel-a");
      assert.equal(state.policies[0].available, 1, "damaged stock must not satisfy the minimum");
      assert.equal((await store.operationsFor("other-hotel")).requests.length, 0);
      assert.throws(() => saveStockPolicy(state, { sku: "TOWEL", minimum: -1, target: 10, automatic: true }, "manager"));
      assert.throws(() => transitionRequest(state, state.requests[0].requestId, "approved", { role: "hotel_admin", actorId: "manager" }));
    } finally { store.close?.(); }
  });
}

test("SQLite hotel directory, stock policies and request history survive restart", async () => {
  const folder = mkdtempSync(join(tmpdir(), "rfid-hotel-"));
  const path = join(folder, "test.db");
  let store = new SqliteStore(path);
  try {
    store.upsertProducts("hotel-a", [product]);
    store.updateOperations("globaltex", s => s.hotels.push({ tenantId: "hotel-a", name: "Grand Hotel" }));
    store.updateOperations("hotel-a", s => saveStockPolicy(s, { sku: "TOWEL", minimum: 5, target: 20, automatic: true }, "manager"));
    const state = await evaluateStock(store, "hotel-a");
    const id = state.requests[0].requestId;
    store.updateOperations("hotel-a", s => transitionRequest(s, id, "approved", { role: "chain_admin", actorId: "globaltex" }));
    store.close(); store = new SqliteStore(path);
    assert.equal(store.operationsFor("globaltex").hotels[0].name, "Grand Hotel");
    assert.equal(store.operationsFor("hotel-a").requests[0].status, "approved");
    assert.equal(store.operationsFor("hotel-a").requests[0].history.length, 2);
    await evaluateStock(store, "hotel-a");
    assert.equal(store.operationsFor("hotel-a").requests.length, 1);
  } finally { store.close(); rmSync(folder, { recursive: true }); }
});

test("Globaltex creates isolated hotel accounts; hotel users cannot encode, provision or approve requests", async () => {
  const store = new InventoryStore();
  const server = createApp({ store,
    credentials: { reader: { tenantId: "globaltex", readerId: "r", secret: "secret" } },
    admin: { token: "test-admin", tenantId: "globaltex", role: "chain_admin" } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Basic ${Buffer.from("admin:test-admin").toString("base64")}` };
  const call = (path, headers = admin, method = "GET", body) => fetch(base + path, {
    method, headers: { ...headers, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  try {
    const created = await call("/v1/admin/hotels", admin, "POST", { name: "Grand Hotel İstanbul" });
    assert.equal(created.status, 201);
    const hotel = await created.json();
    const identity = await (await call("/v1/admin/me")).json();
    assert.ok(identity.tenantIds.includes(hotel.tenantId));
    store.upsertProducts(hotel.tenantId, [product]);
    const createdUser = await call("/v1/admin/users", admin, "POST", {
      username: "hotel@example.com", displayName: "Otel Yetkilisi", password: "hotel-pass-12345",
      role: "hotel_admin", tenantIds: [hotel.tenantId], defaultTenantId: hotel.tenantId
    });
    assert.equal(createdUser.status, 201);
    assert.equal((await call("/v1/admin/users", admin, "POST", {
      username: "wrong-scope@example.com", password: "hotel-pass-12345", role: "hotel_admin",
      tenantIds: ["globaltex"], defaultTenantId: "globaltex"
    })).status, 422, "hotel accounts cannot be assigned to the supplier workspace");
    const login = await call("/v1/auth/login", {}, "POST", { username: "hotel@example.com", password: "hotel-pass-12345" });
    assert.equal(login.status, 200);
    const hotelHeaders = { cookie: login.headers.get("set-cookie").split(";")[0] };
    assert.equal((await call("/v1/admin/assets", { ...hotelHeaders, "x-tenant-id": "globaltex" })).status, 403);
    const page = await call("/dashboard/receiving", hotelHeaders);
    const pageHtml = await page.text();
    assert.match(pageHtml, /My products/);
    assert.doesNotMatch(pageHtml, /id="encoding-form"/);
    for (const path of ["/v1/admin/hardware/rru9809/write", "/v1/admin/hardware/rru9809/scan", "/v1/admin/users", "/v1/admin/hotels", "/v1/admin/catalog/import", "/v1/admin/assets/register"]) {
      assert.equal((await call(path, hotelHeaders, "POST", {})).status, 403, path);
    }
    assert.equal((await call("/v1/admin/stock/policies", hotelHeaders, "PUT", { sku: "TOWEL", minimum: 5, target: 20, automatic: true })).status, 200);
    const state = await (await call("/v1/admin/stock", hotelHeaders)).json();
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].quantity, 20);
    assert.equal((await call(`/v1/admin/stock/requests/${state.requests[0].requestId}`, hotelHeaders, "PUT", { status: "approved" })).status, 422);
    const overview = await (await call("/v1/admin/stock/overview")).json();
    assert.equal(overview.requests[0].tenantId, hotel.tenantId);
    assert.equal((await call(`/v1/admin/stock/requests/${state.requests[0].requestId}`, { ...admin, "x-tenant-id": hotel.tenantId }, "PUT", { status: "approved" })).status, 200);
    assert.equal((await call(`/v1/admin/stock/requests/${state.requests[0].requestId}/dispatch`, hotelHeaders, "POST", {})).status, 403);
    assert.equal((await call(`/v1/admin/stock/requests/${state.requests[0].requestId}/dispatch`, { ...admin, "x-tenant-id": hotel.tenantId }, "POST", { supplierTenantId: "unauthorized" })).status, 403);
    const otherAdmin = { authorization: `Basic ${Buffer.from("wrong-name:test-admin").toString("base64")}` };
    assert.equal((await call("/v1/admin/me", otherAdmin)).status, 401);
    const hotelList = await (await call("/v1/admin/hotels", hotelHeaders)).json();
    assert.deepEqual(hotelList.hotels.map(h => h.name), ["Grand Hotel İstanbul"]);
    await call("/v1/admin/users", admin, "POST", { username: "viewer@example.com", password: "viewer-pass-12345", role: "viewer", tenantIds: [hotel.tenantId], defaultTenantId: hotel.tenantId });
    const viewer = { authorization: `Basic ${Buffer.from("viewer@example.com:viewer-pass-12345").toString("base64")}` };
    assert.equal((await call("/v1/admin/stock/policies", viewer, "PUT", { sku: "TOWEL", minimum: 1, target: 2, automatic: true })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
