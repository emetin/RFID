import test from "node:test";
import assert from "node:assert/strict";
import { InventoryStore } from "../src/core/inventory-store.js";
import { SqliteStore } from "../src/core/sqlite-store.js";

test("offline reader alert can be acknowledged and resolves after recovery", () => {
  const store = new InventoryStore();
  store.recordGatewayHealth({
    tenantId: "hotel-a",
    readerId: "reader-1",
    adapter: "llrp",
    gatewayVersion: "0.1.0",
    readerConnected: true,
    queueDepth: 0,
    heartbeatAt: "2026-07-02T11:00:00.000Z",
    receivedAt: "2026-07-02T11:00:00.000Z"
  });
  store.evaluateOperationalAlerts("hotel-a", {
    now: Date.parse("2026-07-02T11:02:00.000Z")
  });
  const [opened] = store.alertsFor("hotel-a");
  assert.equal(opened.alertType, "reader_health");
  assert.equal(opened.severity, "critical");
  assert.equal(opened.status, "open");

  const acknowledged = store.acknowledgeAlert(
    "hotel-a",
    opened.alertId,
    "operator@example.com",
    "2026-07-02T11:02:10.000Z"
  );
  assert.equal(acknowledged.status, "acknowledged");

  store.recordGatewayHealth({
    tenantId: "hotel-a",
    readerId: "reader-1",
    adapter: "llrp",
    gatewayVersion: "0.1.0",
    readerConnected: true,
    queueDepth: 0,
    heartbeatAt: "2026-07-02T11:02:20.000Z",
    receivedAt: "2026-07-02T11:02:20.000Z"
  });
  store.evaluateOperationalAlerts("hotel-a", {
    now: Date.parse("2026-07-02T11:02:30.000Z")
  });
  assert.equal(store.alertsFor("hotel-a")[0].status, "resolved");
});

test("SQLite creates a persistent critical alert for dead-letter integrations", () => {
  const store = new SqliteStore(":memory:");
  try {
    const event = store.enqueueIntegrationEvent({
      tenantId: "hotel-a",
      eventType: "inventory.movement_confirmed",
      aggregateId: "EPC-1",
      payload: { epc: "EPC-1" },
      createdAt: "2026-07-02T12:00:00.000Z"
    });
    store.markIntegrationFailed("hotel-a", event.eventId, "ERP unavailable", {
      now: Date.parse("2026-07-02T12:01:00.000Z"),
      maxAttempts: 1
    });
    store.evaluateOperationalAlerts("hotel-a", {
      now: Date.parse("2026-07-02T12:01:01.000Z")
    });
    const [alert] = store.alertsFor("hotel-a");
    assert.equal(alert.alertType, "integration_delivery_failed");
    assert.equal(alert.severity, "critical");
    assert.equal(alert.entityId, event.eventId);
  } finally {
    store.close();
  }
});
