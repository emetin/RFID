import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/app.js";
import { InventoryStore } from "../src/core/inventory-store.js";
import { runEncodingWorker } from "../src/encoding/worker.js";

test("encoding worker automatically claims, writes, verifies and completes a batch", async () => {
  const store = new InventoryStore();
  store.upsertProducts("factory-a", [{
    sku: "TOWEL-1", name: "Towel", unitsPerBox: 1, boxesPerPallet: 1
  }]);
  const batch = store.createEncodingBatch("factory-a", {
    sku: "TOWEL-1", requestedQuantity: 3
  });
  const server = createApp({
    credentials: { reader: { tenantId: "factory-a", readerId: "reader", secret: "secret" } },
    customerApiCredentials: {
      "writer-secret": {
        clientId: "writer-service", tenantId: "factory-a",
        scopes: ["encoding:read", "encoding:work"]
      }
    },
    store
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const calls = [];
    const result = await runEncodingWorker({
      apiUrl: `http://127.0.0.1:${server.address().port}`,
      token: "writer-secret",
      stationId: "writer-01",
      maxJobs: 10,
      writer: {
        async writeAndVerify(job) {
          calls.push(job);
          return { observedEpc: job.epc, tid: `TID-${calls.length}` };
        }
      }
    });
    assert.deepEqual({ processed: result.processed, verified: result.verified, failed: result.failed }, {
      processed: 3, verified: 3, failed: 0
    });
    assert.equal(new Set(calls.map((job) => job.epc)).size, 3);
    const completed = store.encodingBatchFor("factory-a", batch.batchId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.verified, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("encoding worker records readback failure and processes its replacement job", async () => {
  const store = new InventoryStore();
  store.upsertProducts("factory-a", [{
    sku: "SHEET-1", name: "Sheet", unitsPerBox: 1, boxesPerPallet: 1
  }]);
  const batch = store.createEncodingBatch("factory-a", { sku: "SHEET-1", requestedQuantity: 1 });
  const server = createApp({
    credentials: { reader: { tenantId: "factory-a", readerId: "reader", secret: "secret" } },
    customerApiCredentials: {
      "writer-secret": { clientId: "writer-service", tenantId: "factory-a", scopes: ["encoding:work"] }
    },
    store
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let attempt = 0;
  try {
    const result = await runEncodingWorker({
      apiUrl: `http://127.0.0.1:${server.address().port}`,
      token: "writer-secret", stationId: "writer-02", maxJobs: 3,
      writer: {
        async writeAndVerify(job) {
          attempt += 1;
          return { observedEpc: attempt === 1 ? "000000000000000000000000" : job.epc };
        }
      }
    });
    assert.deepEqual({ processed: result.processed, verified: result.verified, failed: result.failed }, {
      processed: 2, verified: 1, failed: 1
    });
    const completed = store.encodingBatchFor("factory-a", batch.batchId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.failed, 1);
    assert.equal(completed.totalJobs, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
