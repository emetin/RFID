import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/app.js";
import { sendHeartbeat, sendReads } from "../src/gateway/client.js";
import { signatureFor } from "../src/core/auth.js";
import { InventoryStore } from "../src/core/inventory-store.js";

const credential = { tenantId: "hotel-a", readerId: "reader-1", secret: "test-secret" };

async function withServer(run) {
  const server = createApp({ credentials: { "reader-key": credential } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

async function withAdminServer(run) {
  const store = new InventoryStore();
  const server = createApp({
    credentials: { "reader-key": credential },
    admin: { token: "admin-secret", tenantId: credential.tenantId },
    store
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, store);
  } finally {
    server.close();
  }
}

async function authorizedGet(apiUrl, path) {
  const timestamp = String(Date.now());
  return fetch(`${apiUrl}${path}`, {
    headers: {
      "x-device-key": "reader-key",
      "x-device-timestamp": timestamp,
      "x-device-signature": signatureFor(credential.secret, timestamp, "")
    }
  });
}

test("gateway requires consistent evidence before moving inventory to another zone", async () => {
  await withServer(async (apiUrl) => {
    const event = {
      eventId: "event-1",
      epc: "3034257BF7194E4000000001",
      observedAt: "2026-07-01T09:00:00.000Z",
      rssi: -42,
      antenna: 1
    };
    const first = await sendReads({
      apiUrl,
      deviceKey: "reader-key",
      deviceSecret: credential.secret,
      facilityId: "hotel-1",
      zoneId: "receiving",
      reads: [event]
    });
    assert.deepEqual(first, { accepted: 1, duplicates: 0, unknownAssets: 1 });

    const duplicate = await sendReads({
      apiUrl,
      deviceKey: "reader-key",
      deviceSecret: credential.secret,
      facilityId: "hotel-1",
      zoneId: "receiving",
      reads: [event]
    });
    assert.deepEqual(duplicate, { accepted: 0, duplicates: 1, unknownAssets: 0 });

    await sendReads({
      apiUrl,
      deviceKey: "reader-key",
      deviceSecret: credential.secret,
      facilityId: "hotel-1",
      zoneId: "laundry",
      reads: [{ ...event, eventId: "event-2", observedAt: "2026-07-01T10:00:00.000Z" }]
    });

    const pendingInventory = await authorizedGet(apiUrl, "/v1/inventory");
    const { items: pendingItems } = await pendingInventory.json();
    assert.equal(pendingItems[0].zoneId, "receiving");

    await sendReads({
      apiUrl,
      deviceKey: "reader-key",
      deviceSecret: credential.secret,
      facilityId: "hotel-1",
      zoneId: "laundry",
      reads: [{ ...event, eventId: "event-3", observedAt: "2026-07-01T10:00:05.000Z" }]
    });

    const response = await authorizedGet(apiUrl, "/v1/inventory");
    const { items } = await response.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].zoneId, "laundry");
    assert.equal(items[0].readCount, 3);
  });
});

test("rejects a request with the wrong device secret", async () => {
  await withServer(async (apiUrl) => {
    await assert.rejects(
      sendReads({
        apiUrl,
        deviceKey: "reader-key",
        deviceSecret: "wrong",
        facilityId: "hotel-1",
        zoneId: "receiving",
        reads: [{ epc: "3034257BF7194E4000000001" }]
      }),
      /401/
    );
  });
});

test("inventory reads also require a valid signature", async () => {
  await withServer(async (apiUrl) => {
    const response = await fetch(`${apiUrl}/v1/inventory`, {
      headers: { "x-device-key": "reader-key" }
    });
    assert.equal(response.status, 401);
  });
});

test("admin can import the product CSV and load the English dashboard", async () => {
  await withAdminServer(async (apiUrl) => {
    const authorization = `Basic ${Buffer.from("admin:admin-secret").toString("base64")}`;
    const imported = await fetch(`${apiUrl}/v1/admin/catalog/import`, {
      method: "POST",
      headers: { authorization, "content-type": "text/csv" },
      body: "sku,name,category,units_per_box,boxes_per_pallet,size,color\nBT-001,Bath Towel,Towels,24,20,27x54,White\n"
    });
    assert.equal(imported.status, 200);
    assert.deepEqual(await imported.json(), { imported: 1 });

    const dashboard = await fetch(`${apiUrl}/dashboard`, { headers: { authorization } });
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /RFID OPERATIONS/);
    const inventoryPage = await fetch(`${apiUrl}/dashboard/inventory`, {
      headers: { authorization }
    });
    assert.equal(inventoryPage.status, 200);
    assert.match(await inventoryPage.text(), /Inventory by product/);
  });
});

test("signed Gateway heartbeat reports degraded queue health to its tenant only", async () => {
  await withAdminServer(async (apiUrl, store) => {
    const storeHeartbeat = {
      adapter: "llrp",
      gatewayVersion: "0.1.0",
      readerConnected: true,
      queueDepth: 4,
      lastReadAt: "2026-07-01T17:30:00.000Z",
      lastError: "cloud retry pending",
      heartbeatAt: new Date().toISOString()
    };
    const accepted = await sendHeartbeat({
      apiUrl,
      deviceKey: "reader-key",
      deviceSecret: credential.secret,
      heartbeat: storeHeartbeat
    });
    assert.equal(accepted.readerId, credential.readerId);
    assert.equal(accepted.status, "degraded");
    store.recordGatewayHealth({
      tenantId: "unrelated-hotel",
      readerId: "other-reader",
      adapter: "mqtt",
      gatewayVersion: "0.1.0",
      readerConnected: true,
      queueDepth: 0,
      heartbeatAt: new Date().toISOString()
    });

    const authorization = `Basic ${Buffer.from("admin:admin-secret").toString("base64")}`;
    const response = await fetch(`${apiUrl}/v1/admin/readers/health`, {
      headers: { authorization }
    });
    assert.equal(response.status, 200);
    const { readers } = await response.json();
    assert.equal(readers.length, 1);
    assert.equal(readers[0].queueDepth, 4);
    assert.equal(readers[0].status, "degraded");
  });
});

test("provisioned reader can write only to its assigned hotel zone", async () => {
  const store = new InventoryStore();
  const server = createApp({
    credentials: { "reader-key": credential },
    admin: { token: "admin-secret", tenantId: credential.tenantId },
    store,
    requireProvisionedReaders: true
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from("admin:admin-secret").toString("base64")}`;
  const adminPost = (path, value) => fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(value)
  });

  try {
    assert.equal((await adminPost("/v1/admin/facilities", {
      facilityId: "hotel-1",
      name: "Istanbul Hotel",
      facilityType: "hotel",
      timezone: "Europe/Istanbul"
    })).status, 200);
    assert.equal((await adminPost("/v1/admin/zones", {
      zoneId: "receiving",
      facilityId: "hotel-1",
      name: "Receiving",
      zoneType: "receiving"
    })).status, 200);
    assert.equal((await adminPost("/v1/admin/readers", {
      readerId: credential.readerId,
      facilityId: "hotel-1",
      zoneId: "receiving",
      name: "Dock Door Reader",
      adapter: "llrp"
    })).status, 200);

    await assert.rejects(
      sendReads({
        apiUrl,
        deviceKey: "reader-key",
        deviceSecret: credential.secret,
        facilityId: "hotel-1",
        zoneId: "laundry",
        reads: [{ epc: "3034257BF7194E4000000701" }]
      }),
      /403/
    );

    const accepted = await sendReads({
      apiUrl,
      deviceKey: "reader-key",
      deviceSecret: credential.secret,
      facilityId: "hotel-1",
      zoneId: "receiving",
      reads: [{ epc: "3034257BF7194E4000000701" }]
    });
    assert.equal(accepted.accepted, 1);

    store.upsertFacility("unrelated-hotel", {
      facilityId: "other-hotel",
      name: "Other Hotel",
      facilityType: "hotel"
    });
    const facilitiesResponse = await fetch(`${apiUrl}/v1/admin/facilities`, {
      headers: { authorization }
    });
    const { facilities } = await facilitiesResponse.json();
    assert.deepEqual(facilities.map((item) => item.facilityId), ["hotel-1"]);
  } finally {
    server.close();
  }
});

test("chain admin switches authorized tenants while viewer mutations are audited and blocked", async () => {
  const store = new InventoryStore();
  const server = createApp({
    credentials: {
      "dummy-reader": {
        tenantId: "hotel-a",
        readerId: "reader-1",
        secret: "reader-secret"
      }
    },
    admin: {
      identities: {
        "chain-secret": {
          actorId: "chain-ops",
          role: "chain_admin",
          tenantIds: ["hotel-a", "hotel-b"],
          defaultTenantId: "hotel-a"
        },
        "viewer-secret": {
          actorId: "auditor",
          role: "viewer",
          tenantIds: ["hotel-a"]
        }
      }
    },
    store
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const chainAuthorization = `Basic ${Buffer.from("admin:chain-secret").toString("base64")}`;
  const viewerAuthorization = `Basic ${Buffer.from("admin:viewer-secret").toString("base64")}`;

  try {
    const identityResponse = await fetch(`${apiUrl}/v1/admin/me`, {
      headers: {
        authorization: chainAuthorization,
        "x-tenant-id": "hotel-b"
      }
    });
    assert.equal(identityResponse.status, 200);
    assert.deepEqual(await identityResponse.json(), {
      actorId: "chain-ops",
      displayName: "chain-ops",
      role: "chain_admin",
      tenantId: "hotel-b",
      tenantIds: ["hotel-a", "hotel-b"],
      managed: false,
      userId: null
    });

    for (const tenantId of ["hotel-a", "hotel-b"]) {
      const response = await fetch(`${apiUrl}/v1/admin/facilities`, {
        method: "POST",
        headers: {
          authorization: chainAuthorization,
          "x-tenant-id": tenantId,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          facilityId: `${tenantId}-property`,
          name: `${tenantId} Property`,
          facilityType: "hotel"
        })
      });
      assert.equal(response.status, 200);
    }

    const viewerMutation = await fetch(`${apiUrl}/v1/admin/facilities`, {
      method: "POST",
      headers: {
        authorization: viewerAuthorization,
        "x-tenant-id": "hotel-a",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        facilityId: "forbidden",
        name: "Forbidden",
        facilityType: "hotel"
      })
    });
    assert.equal(viewerMutation.status, 403);
    const viewerRetentionMutation = await fetch(
      `${apiUrl}/v1/admin/retention/read-events`,
      {
        method: "POST",
        headers: {
          authorization: viewerAuthorization,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          before: "2026-06-01T00:00:00.000Z",
          dryRun: false
        })
      }
    );
    assert.equal(viewerRetentionMutation.status, 403);

    const forbiddenTenant = await fetch(`${apiUrl}/v1/admin/facilities`, {
      headers: {
        authorization: viewerAuthorization,
        "x-tenant-id": "hotel-b"
      }
    });
    assert.equal(forbiddenTenant.status, 403);

    const auditResponse = await fetch(`${apiUrl}/v1/admin/audit`, {
      headers: {
        authorization: chainAuthorization,
        "x-tenant-id": "hotel-a"
      }
    });
    const { events } = await auditResponse.json();
    assert.equal(events.length, 1);
    assert.equal(events[0].actorId, "chain-ops");
    assert.equal(events[0].actorRole, "chain_admin");
    assert.equal(events[0].action, "POST /v1/admin/facilities");
  } finally {
    server.close();
  }
});

test("chain admin receives an allowlisted multi-hotel inventory rollup", async () => {
  const store = new InventoryStore();
  const tenants = ["hotel-a", "hotel-b"];
  for (const tenantId of tenants) {
    store.upsertProducts(tenantId, [{
      sku: "BT-001",
      name: "Bath Towel",
      category: "Towels",
      unitsPerBox: 2,
      boxesPerPallet: 2
    }]);
  }
  store.registerAssets("hotel-a", [{
    epc: "3034257BF7194E4000000901",
    sku: "BT-001"
  }]);
  store.registerAssets("hotel-b", [
    { epc: "3034257BF7194E4000000902", sku: "BT-001" },
    { epc: "3034257BF7194E4000000903", sku: "BT-001" }
  ]);
  for (const [tenantId, epcs] of [
    ["hotel-a", ["3034257BF7194E4000000901"]],
    ["hotel-b", ["3034257BF7194E4000000902", "3034257BF7194E4000000903"]]
  ]) {
    store.ingest({
      tenantId,
      readerId: "reader-1",
      facilityId: `${tenantId}-property`,
      zoneId: "linen-room",
      events: epcs.map((epc, index) => ({
        eventId: `${tenantId}-chain-${index}`,
        epc,
        observedAt: "2026-07-02T18:00:00.000Z"
      }))
    });
  }

  const server = createApp({
    credentials: {
      "dummy-reader": {
        tenantId: "hotel-a",
        readerId: "reader-1",
        secret: "reader-secret"
      }
    },
    admin: {
      identities: {
        "chain-secret": {
          actorId: "chain-director",
          role: "chain_admin",
          tenantIds: tenants,
          defaultTenantId: "hotel-a"
        },
        "viewer-secret": {
          actorId: "hotel-a-viewer",
          role: "viewer",
          tenantIds: ["hotel-a"]
        }
      }
    },
    store
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const chainAuthorization = `Basic ${Buffer.from("admin:chain-secret").toString("base64")}`;
  const viewerAuthorization = `Basic ${Buffer.from("admin:viewer-secret").toString("base64")}`;
  try {
    const response = await fetch(`${apiUrl}/v1/admin/chain/summary`, {
      headers: { authorization: chainAuthorization }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.tenantCount, 2);
    assert.deepEqual(result.totals, {
      uniqueUnits: 3,
      registeredUnits: 3,
      unknownUnits: 0,
      availableUnits: 3,
      statusCounts: {
        active: 3,
        quarantined: 0,
        damaged: 0,
        lost: 0,
        retired: 0,
        unregistered: 0
      }
    });
    assert.equal(result.lines[0].sku, "BT-001");
    assert.equal(result.lines[0].units, 3);
    assert.equal(result.lines[0].tenantCount, 2);
    assert.equal(result.lines[0].fullBoxes, 1);
    assert.equal(result.lines[0].looseUnits, 1);
    assert.deepEqual(
      result.tenants.map((tenant) => [tenant.tenantId, tenant.uniqueUnits]),
      [["hotel-a", 1], ["hotel-b", 2]]
    );

    const forbidden = await fetch(`${apiUrl}/v1/admin/chain/summary`, {
      headers: { authorization: viewerAuthorization }
    });
    assert.equal(forbidden.status, 403);
  } finally {
    server.close();
  }
});

test("custom login creates persistent users with scoped hotel access", async () => {
  const store = new InventoryStore();
  const server = createApp({
    credentials: {
      dummy: { tenantId: "hotel-a", readerId: "reader-1", secret: "reader-secret" }
    },
    admin: {
      identities: {
        "chain-secret": {
          actorId: "bootstrap-admin",
          role: "chain_admin",
          tenantIds: ["hotel-a", "hotel-b"],
          defaultTenantId: "hotel-a"
        }
      }
    },
    store,
    sessionSecret: "test-session-secret-at-least-24"
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const loginPage = await fetch(`${apiUrl}/login`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /Welcome back/);

    const bootstrapLogin = await fetch(`${apiUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "chain-secret" })
    });
    assert.equal(bootstrapLogin.status, 200);
    const bootstrapCookie = bootstrapLogin.headers.get("set-cookie").split(";")[0];

    const createdResponse = await fetch(`${apiUrl}/v1/admin/users`, {
      method: "POST",
      headers: {
        cookie: bootstrapCookie,
        "content-type": "application/json",
        "x-tenant-id": "hotel-a"
      },
      body: JSON.stringify({
        username: "operator@example.com",
        displayName: "Receiving Operator",
        password: "secure-password-123",
        role: "operator",
        tenantIds: ["hotel-a"],
        defaultTenantId: "hotel-a"
      })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.role, "operator");
    assert.deepEqual(created.tenantIds, ["hotel-a"]);
    assert.equal("passwordHash" in created, false);

    const managedLogin = await fetch(`${apiUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "operator@example.com",
        password: "secure-password-123"
      })
    });
    assert.equal(managedLogin.status, 200);
    const managedCookie = managedLogin.headers.get("set-cookie").split(";")[0];
    const identity = await fetch(`${apiUrl}/v1/admin/me`, {
      headers: { cookie: managedCookie }
    });
    const principal = await identity.json();
    assert.equal(principal.managed, true);
    assert.equal(principal.role, "operator");
    assert.deepEqual(principal.tenantIds, ["hotel-a"]);

    const forbiddenHotel = await fetch(`${apiUrl}/v1/admin/me`, {
      headers: { cookie: managedCookie, "x-tenant-id": "hotel-b" }
    });
    assert.equal(forbiddenHotel.status, 403);
    const forbiddenUsers = await fetch(`${apiUrl}/v1/admin/users`, {
      headers: { cookie: managedCookie }
    });
    assert.equal(forbiddenUsers.status, 403);
  } finally {
    server.close();
  }
});

test("hotel admin previews and executes raw read retention through the API", async () => {
  await withAdminServer(async (apiUrl, store) => {
    store.ingest({
      tenantId: credential.tenantId,
      readerId: credential.readerId,
      facilityId: "hotel-1",
      zoneId: "receiving",
      events: [{
        eventId: "retention-api-old",
        epc: "3034257BF7194E4000000801",
        observedAt: "2026-01-01T00:00:00.000Z"
      }],
      receivedAt: "2026-01-01T00:00:01.000Z"
    });
    const authorization = `Basic ${Buffer.from("admin:admin-secret").toString("base64")}`;
    const preview = await fetch(
      `${apiUrl}/v1/admin/retention/read-events?before=2026-06-01T00%3A00%3A00.000Z`,
      { headers: { authorization } }
    );
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).eligible, 1);

    const execute = await fetch(`${apiUrl}/v1/admin/retention/read-events`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        before: "2026-06-01T00:00:00.000Z",
        limit: 100,
        dryRun: false
      })
    });
    assert.equal(execute.status, 200);
    const result = await execute.json();
    assert.equal(result.deleted, 1);
    assert.equal(store.inventoryFor(credential.tenantId).length, 1);
  });
});

test("operator acknowledges a tenant alert through the admin API", async () => {
  const store = new InventoryStore();
  const alert = store.raiseAlert({
    tenantId: "hotel-a",
    dedupeKey: "manual:test",
    alertType: "manual_test",
    severity: "warning",
    entityType: "reader",
    entityId: "reader-1",
    title: "Test alert",
    message: "Operator acknowledgement required."
  });
  const server = createApp({
    credentials: {
      "dummy-reader": {
        tenantId: "hotel-a",
        readerId: "reader-1",
        secret: "reader-secret"
      }
    },
    admin: {
      identities: {
        "operator-secret": {
          actorId: "night-operator",
          role: "operator",
          tenantIds: ["hotel-a"]
        }
      }
    },
    store
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from("admin:operator-secret").toString("base64")}`;
  try {
    const response = await fetch(
      `${apiUrl}/v1/admin/alerts/${alert.alertId}/acknowledge`,
      { method: "POST", headers: { authorization } }
    );
    assert.equal(response.status, 200);
    const acknowledged = await response.json();
    assert.equal(acknowledged.status, "acknowledged");
    assert.equal(acknowledged.acknowledgedBy, "night-operator");
  } finally {
    server.close();
  }
});

test("operator lists and resolves a tenant exception through the admin API", async () => {
  const store = new InventoryStore();
  const exception = store.raiseException({
    tenantId: "hotel-a",
    dedupeKey: "unknown-asset:3034257BF7194E4000000888",
    exceptionType: "unknown_asset",
    severity: "warning",
    epc: "3034257BF7194E4000000888",
    details: { zoneId: "receiving" }
  });
  const server = createApp({
    credentials: {
      dummy: {
        tenantId: "hotel-a",
        readerId: "reader-1",
        secret: "reader-secret"
      }
    },
    admin: {
      identities: {
        "operator-secret": {
          actorId: "receiving-operator",
          role: "operator",
          tenantIds: ["hotel-a"]
        }
      }
    },
    store
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from("admin:operator-secret").toString("base64")}`;
  try {
    const listed = await fetch(`${apiUrl}/v1/admin/exceptions?status=open`, {
      headers: { authorization }
    });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).exceptions.length, 1);

    const response = await fetch(
      `${apiUrl}/v1/admin/exceptions/${exception.caseId}/resolve`,
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ resolution: "quarantined" })
      }
    );
    assert.equal(response.status, 200);
    const resolved = await response.json();
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolvedBy, "receiving-operator");
  } finally {
    server.close();
  }
});

test("operator updates asset lifecycle while retirement remains admin-only", async () => {
  const store = new InventoryStore();
  const epc = "3034257BF7194E4000000777";
  store.upsertProducts("hotel-a", [{
    sku: "BT-001",
    name: "Bath Towel",
    unitsPerBox: 2,
    boxesPerPallet: 2
  }]);
  store.registerAssets("hotel-a", [{ epc, sku: "BT-001" }]);
  const server = createApp({
    credentials: {
      dummy: {
        tenantId: "hotel-a",
        readerId: "reader-1",
        secret: "reader-secret"
      }
    },
    admin: {
      identities: {
        "operator-secret": {
          actorId: "linen-operator",
          role: "operator",
          tenantIds: ["hotel-a"]
        }
      }
    },
    store
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from("admin:operator-secret").toString("base64")}`;
  const update = (status, reason) => fetch(`${apiUrl}/v1/admin/assets/${epc}/status`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ status, reason })
  });
  try {
    const quarantined = await update("quarantined", "Quality review");
    assert.equal(quarantined.status, 200);
    assert.equal((await quarantined.json()).asset.status, "quarantined");

    const history = await fetch(`${apiUrl}/v1/admin/assets/${epc}/lifecycle`, {
      headers: { authorization }
    });
    assert.equal(history.status, 200);
    assert.equal((await history.json()).history.length, 2);

    const retired = await update("retired", "End of life");
    assert.equal(retired.status, 403);
  } finally {
    server.close();
  }
});

test("shipment receiving reconciles EPCs and transfers accepted assets to the hotel", async () => {
  const store = new InventoryStore();
  const supplierTenantId = "globaltex";
  const hotelTenantId = "hotel-chain-a";
  const hotelCredential = {
    tenantId: hotelTenantId,
    readerId: "hotel-receiving-reader",
    secret: "hotel-reader-secret"
  };
  const epcs = [
    "3034257BF7194E4000000201",
    "3034257BF7194E4000000202",
    "3034257BF7194E4000000203"
  ];
  store.upsertProducts(supplierTenantId, [{
    sku: "BT-001",
    name: "Bath Towel",
    unitsPerBox: 24,
    boxesPerPallet: 20
  }]);
  store.registerAssets(
    supplierTenantId,
    epcs.map((epc) => ({ epc, sku: "BT-001" }))
  );

  const supplierServer = createApp({
    credentials: {
      "supplier-reader": {
        tenantId: supplierTenantId,
        readerId: "supplier-reader",
        secret: "supplier-secret"
      }
    },
    admin: { token: "supplier-admin", tenantId: supplierTenantId },
    store
  });
  const hotelServer = createApp({
    credentials: { "hotel-reader": hotelCredential },
    admin: { token: "hotel-admin", tenantId: hotelTenantId },
    store
  });
  await Promise.all([
    new Promise((resolve) => supplierServer.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => hotelServer.listen(0, "127.0.0.1", resolve))
  ]);

  const supplierUrl = `http://127.0.0.1:${supplierServer.address().port}`;
  const hotelUrl = `http://127.0.0.1:${hotelServer.address().port}`;
  const supplierAuth = `Basic ${Buffer.from("admin:supplier-admin").toString("base64")}`;
  const hotelAuth = `Basic ${Buffer.from("admin:hotel-admin").toString("base64")}`;

  try {
    const created = await fetch(`${supplierUrl}/v1/admin/shipments`, {
      method: "POST",
      headers: { authorization: supplierAuth, "content-type": "application/json" },
      body: JSON.stringify({
        shipmentId: "shipment-1001",
        customerTenantId: hotelTenantId,
        destinationFacilityId: "hotel-istanbul-1",
        reference: "PO-1001",
        epcs
      })
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).assetCount, 3);

    const sessionResponse = await fetch(`${hotelUrl}/v1/admin/sessions`, {
      method: "POST",
      headers: { authorization: hotelAuth, "content-type": "application/json" },
      body: JSON.stringify({
        facilityId: "hotel-istanbul-1",
        zoneId: "receiving",
        type: "receiving",
        reference: "PO-1001"
      })
    });
    assert.equal(sessionResponse.status, 201);
    const session = await sessionResponse.json();
    const unexpectedEpc = "3034257BF7194E4000000999";

    await sendReads({
      apiUrl: hotelUrl,
      deviceKey: "hotel-reader",
      deviceSecret: hotelCredential.secret,
      facilityId: "hotel-istanbul-1",
      zoneId: "receiving",
      sessionId: session.sessionId,
      reads: [
        { epc: epcs[0] },
        { epc: epcs[1] },
        { epc: unexpectedEpc }
      ]
    });

    const reconciliationResponse = await fetch(
      `${hotelUrl}/v1/admin/shipments/shipment-1001/reconciliation?sessionId=${session.sessionId}`,
      { headers: { authorization: hotelAuth } }
    );
    assert.equal(reconciliationResponse.status, 200);
    const reconciliation = await reconciliationResponse.json();
    assert.equal(reconciliation.receivedCount, 2);
    assert.deepEqual(reconciliation.missing, [epcs[2]]);
    assert.deepEqual(reconciliation.unexpected, [unexpectedEpc]);

    const acceptedResponse = await fetch(
      `${hotelUrl}/v1/admin/shipments/shipment-1001/accept`,
      {
        method: "POST",
        headers: { authorization: hotelAuth, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.sessionId })
      }
    );
    assert.equal(acceptedResponse.status, 200);
    const accepted = await acceptedResponse.json();
    assert.equal(accepted.shipment.status, "partially_received");
    assert.equal(accepted.shipment.acceptedAssetCount, 2);

    const timestamp = String(Date.now());
    const inventoryResponse = await fetch(`${hotelUrl}/v1/inventory`, {
      headers: {
        "x-device-key": "hotel-reader",
        "x-device-timestamp": timestamp,
        "x-device-signature": signatureFor(hotelCredential.secret, timestamp, "")
      }
    });
    const { items } = await inventoryResponse.json();
    assert.equal(items.filter((item) => item.sku === "BT-001").length, 2);
    assert.equal(items.find((item) => item.epc === unexpectedEpc).assetStatus, "unregistered");
    assert.equal(store.shipmentsFor(supplierTenantId).length, 1);
    assert.equal(store.shipmentsFor(hotelTenantId).length, 1);
    const supplierCustody = store.custodyHistoryFor(supplierTenantId, { epc: epcs[0] });
    const hotelCustody = store.custodyHistoryFor(hotelTenantId, { epc: epcs[0] });
    assert.equal(supplierCustody[0].changeType, "registered");
    assert.notEqual(supplierCustody[0].validTo, null);
    assert.equal(hotelCustody[0].changeType, "shipment_received");
    assert.equal(hotelCustody[0].facilityId, "hotel-istanbul-1");
    assert.equal(
      store.assetLifecycleFor(hotelTenantId, epcs[0])[0].reason,
      "custody_transfer"
    );
    assert.throws(
      () => store.registerAssets(hotelTenantId, [{ epc: epcs[2], sku: "BT-001" }]),
      /already assigned to tenant/
    );
  } finally {
    supplierServer.close();
    hotelServer.close();
  }
});
