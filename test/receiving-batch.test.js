import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InventoryStore } from "../src/core/inventory-store.js";
import { SqliteStore } from "../src/core/sqlite-store.js";

function seed(store, tenantId = "globaltex-local") {
  store.upsertProducts(tenantId, [{
    sku: "BT-001",
    name: "Bath Towel",
    category: "Towels",
    unitsPerBox: 10,
    boxesPerPallet: 10
  }]);
  store.upsertFacility(tenantId, {
    facilityId: "globaltex-main",
    name: "Globaltex Main",
    facilityType: "warehouse",
    timezone: "Europe/Istanbul"
  });
  store.upsertZone(tenantId, {
    zoneId: "receiving",
    facilityId: "globaltex-main",
    name: "Receiving",
    zoneType: "receiving"
  });
}

function verifyApprovalFlow(store) {
  const tenantId = "globaltex-local";
  seed(store, tenantId);
  const batch = store.createReceivingBatch({
    tenantId,
    sku: "BT-001",
    expectedQuantity: 2,
    facilityId: "globaltex-main",
    zoneId: "receiving",
    reference: "PO-1000"
  });
  assert.equal(store.summaryFor(tenantId).uniqueUnits, 0);
  let staged = store.addReceivingBatchReads({
    tenantId,
    batchId: batch.batchId,
    epcs: ["3034257BF7194E4000001001"]
  });
  assert.equal(staged.scannedQuantity, 1);
  assert.equal(staged.canApprove, false);
  staged = store.removeReceivingBatchTag({
    tenantId, batchId: batch.batchId, epc: "3034257BF7194E4000001001"
  });
  assert.equal(staged.scannedQuantity, 0);
  staged = store.addReceivingBatchReads({
    tenantId,
    batchId: batch.batchId,
    epcs: ["3034257BF7194E4000001001"]
  });
  assert.throws(() => store.approveReceivingBatch({
    tenantId, batchId: batch.batchId, actorId: "admin"
  }), /reconcile/);
  staged = store.addReceivingBatchReads({
    tenantId,
    batchId: batch.batchId,
    epcs: ["3034257BF7194E4000001001", "3034257BF7194E4000001002"]
  });
  assert.equal(staged.scannedQuantity, 2);
  assert.equal(staged.tags[0].readCount, 2);
  assert.equal(staged.canApprove, true);
  const approved = store.approveReceivingBatch({
    tenantId, batchId: batch.batchId, actorId: "admin"
  });
  assert.equal(approved.status, "approved");
  assert.equal(store.summaryFor(tenantId).uniqueUnits, 2);
  assert.equal(store.summaryFor(tenantId).availableUnits, 2);
}

test("receiving batch stays outside inventory until explicit approval", () => {
  verifyApprovalFlow(new InventoryStore());
});

test("SQLite receiving batch approval is transactional and persistent", () => {
  const directory = mkdtempSync(join(tmpdir(), "globaltex-receiving-"));
  const path = join(directory, "rfid.db");
  try {
    const store = new SqliteStore(path);
    verifyApprovalFlow(store);
    store.close();
    const reopened = new SqliteStore(path);
    assert.equal(reopened.summaryFor("globaltex-local").uniqueUnits, 2);
    assert.equal(reopened.receivingBatchesFor("globaltex-local")[0].status, "approved");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
