import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildReadBatch } from "../src/gateway/client.js";
import { flushOfflineQueue, OfflineQueue } from "../src/gateway/offline-queue.js";

test("encrypted Edge queue survives restart without exposing EPC payloads", () => {
  const directory = mkdtempSync(join(tmpdir(), "globaltex-edge-"));
  const path = join(directory, "queue.db");
  const epc = "3034257BF7194E4000000501";
  const key = "test-edge-encryption-key";
  try {
    const first = new OfflineQueue(path, { encryptionKey: key });
    first.enqueue(buildReadBatch({
      facilityId: "hotel-1",
      zoneId: "receiving",
      reads: [{ eventId: "edge-event-1", epc }]
    }), "queue-1");

    const inspection = new DatabaseSync(path, { readOnly: true });
    const raw = inspection.prepare(`
      SELECT payload, encoding FROM queued_batches WHERE queue_id = 'queue-1'
    `).get();
    inspection.close();
    assert.equal(raw.encoding, "aes-256-gcm");
    assert.equal(raw.payload.includes(epc), false);
    first.close();

    const reopened = new OfflineQueue(path, { encryptionKey: key });
    const [pending] = reopened.pending();
    assert.equal(pending.queueId, "queue-1");
    assert.equal(pending.batch.events[0].eventId, "edge-event-1");
    assert.equal(pending.batch.events[0].epc, epc);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed synchronization retains batches and later retries exact event IDs", async () => {
  const queue = new OfflineQueue(":memory:", { encryptionKey: "queue-key" });
  const batches = [
    buildReadBatch({
      facilityId: "hotel-1",
      zoneId: "receiving",
      reads: [{
        eventId: "stable-event-1",
        epc: "3034257BF7194E4000000601",
        observedAt: "2026-07-01T17:00:00.000Z"
      }]
    }),
    buildReadBatch({
      facilityId: "hotel-1",
      zoneId: "receiving",
      reads: [{
        eventId: "stable-event-2",
        epc: "3034257BF7194E4000000602",
        observedAt: "2026-07-01T17:00:01.000Z"
      }]
    })
  ];
  queue.enqueue(batches[0], "queue-1");
  queue.enqueue(batches[1], "queue-2");

  const offline = await flushOfflineQueue({
    queue,
    send: async () => {
      throw new Error("network unavailable");
    }
  });
  assert.equal(offline.sent, 0);
  assert.equal(offline.remaining, 2);
  assert.equal(queue.pending()[0].attempts, 1);

  const delivered = [];
  const online = await flushOfflineQueue({
    queue,
    send: async (batch) => delivered.push(batch),
    limit: 1
  });
  assert.equal(online.sent, 2);
  assert.equal(online.remaining, 0);
  assert.deepEqual(
    delivered.map((batch) => batch.events[0].eventId),
    ["stable-event-1", "stable-event-2"]
  );
  queue.close();
});
