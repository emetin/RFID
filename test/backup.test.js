import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/core/sqlite-store.js";
import { createBackup, verifyBackup } from "../src/ops/backup.js";

test("verified SQLite backup preserves RFID inventory and produces a hash manifest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "globaltex-backup-"));
  const sourcePath = join(directory, "rfid.db");
  const backupDir = join(directory, "backups");
  try {
    const store = new SqliteStore(sourcePath);
    store.upsertProducts("hotel-a", [{
      sku: "BT-001",
      name: "Bath Towel",
      unitsPerBox: 24,
      boxesPerPallet: 20
    }]);
    store.registerAssets("hotel-a", [{
      epc: "3034257BF7194E4000000901",
      sku: "BT-001"
    }]);
    store.ingest({
      tenantId: "hotel-a",
      readerId: "reader-1",
      facilityId: "hotel-1",
      zoneId: "receiving",
      events: [{
        eventId: "backup-read-1",
        epc: "3034257BF7194E4000000901",
        observedAt: "2026-07-02T13:00:00.000Z"
      }]
    });
    store.close();

    const backup = await createBackup({
      sourcePath,
      backupDir,
      now: new Date("2026-07-02T13:05:00.000Z")
    });
    assert.equal(existsSync(backup.backupPath), true);
    assert.equal(existsSync(backup.manifestPath), true);
    assert.equal(backup.integrity, "ok");
    assert.match(backup.sha256, /^[0-9a-f]{64}$/);

    const manifest = JSON.parse(readFileSync(backup.manifestPath, "utf8"));
    const verified = await verifyBackup(backup.backupPath, {
      expectedSha256: manifest.sha256
    });
    assert.equal(verified.integrity, "ok");

    const restored = new DatabaseSync(backup.backupPath, { readOnly: true });
    const inventory = restored.prepare(`
      SELECT epc, zone_id FROM inventory_positions
      WHERE tenant_id = 'hotel-a'
    `).get();
    restored.close();
    assert.equal(inventory.epc, "3034257BF7194E4000000901");
    assert.equal(inventory.zone_id, "receiving");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
