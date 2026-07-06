import { buildReadBatch, sendBatch, sendHeartbeat } from "./client.js";
import { flushOfflineQueue, OfflineQueue } from "./offline-queue.js";

export async function runGatewayAdapter({
  adapter,
  gateway,
  queuePath = "data/runtime/edge-queue.db",
  encryptionKey,
  gatewayVersion = "0.1.0"
}) {
  if (process.env.NODE_ENV === "production" && !encryptionKey) {
    throw new Error("EDGE_QUEUE_KEY is required in production");
  }
  const queue = new OfflineQueue(queuePath, { encryptionKey });
  let lastReadAt = null;
  let collected = 0;
  try {
    let reads = [];
    const enqueue = () => {
      if (!reads.length) return;
      const batch = buildReadBatch({
        facilityId: gateway.facilityId,
        zoneId: gateway.zoneId,
        sessionId: gateway.sessionId,
        reads
      });
      queue.enqueue(batch);
      lastReadAt = batch.events.at(-1)?.observedAt ?? lastReadAt;
      reads = [];
    };
    for await (const read of adapter.reads()) {
      reads.push(read);
      collected += 1;
      if (reads.length === 5000) enqueue();
    }
    enqueue();

    const result = await flushOfflineQueue({
      queue,
      send: (batch) => sendBatch({ ...gateway, batch })
    });
    const health = adapter.health();
    let heartbeatReported = false;
    try {
      await sendHeartbeat({
        ...gateway,
        heartbeat: {
          adapter: `${adapter.manifest.id}@${adapter.manifest.version}`,
          gatewayVersion,
          readerConnected: health.readerConnected,
          queueDepth: queue.size(),
          lastReadAt,
          lastError: result.error ?? health.lastError ?? null,
          heartbeatAt: new Date().toISOString()
        }
      });
      heartbeatReported = true;
    } catch {
      // Queue synchronization result remains the actionable delivery state.
    }
    return {
      adapterId: adapter.manifest.id,
      adapterVersion: adapter.manifest.version,
      collectedReads: collected,
      queuedBatches: queue.size(),
      sentBatches: result.sent,
      heartbeatReported,
      status: result.error ? "queued_offline" : "synchronized",
      ...(result.error ? { lastError: result.error } : {})
    };
  } finally {
    await adapter.close();
    queue.close();
  }
}
