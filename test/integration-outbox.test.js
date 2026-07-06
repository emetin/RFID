import test from "node:test";
import assert from "node:assert/strict";
import { InventoryStore } from "../src/core/inventory-store.js";
import {
  deliverIntegrationOutbox,
  integrationSignature
} from "../src/integrations/outbox-delivery.js";

test("confirmed inventory events are delivered as signed retry-safe webhooks", async () => {
  const store = new InventoryStore();
  store.ingest({
    tenantId: "hotel-a",
    readerId: "reader-1",
    facilityId: "hotel-1",
    zoneId: "receiving",
    events: [{
      eventId: "read-1",
      epc: "3034257BF7194E4000000801",
      observedAt: "2026-07-02T09:00:00.000Z"
    }]
  });
  const [queued] = store.integrationOutboxFor("hotel-a");
  assert.equal(queued.eventType, "inventory.position_initialized");

  const requests = [];
  const deliveryTime = Date.now() + 60_000;
  const now = () => deliveryTime;
  const result = await deliverIntegrationOutbox({
    store,
    tenantId: "hotel-a",
    endpoint: "https://erp.example.test/rfid-events",
    secret: "webhook-secret",
    now,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    }
  });
  assert.equal(result.delivered, 1);
  assert.equal(store.integrationOutboxFor("hotel-a")[0].status, "delivered");
  const [{ url, options }] = requests;
  assert.equal(url, "https://erp.example.test/rfid-events");
  assert.equal(options.headers["x-globaltex-event-id"], queued.eventId);
  assert.equal(
    options.headers["x-globaltex-signature"],
    `v1=${integrationSignature(
      "webhook-secret",
      options.headers["x-globaltex-timestamp"],
      options.body
    )}`
  );
});

test("failed webhooks enter dead letter and can be manually retried", async () => {
  const store = new InventoryStore();
  const event = store.enqueueIntegrationEvent({
    tenantId: "hotel-a",
    eventType: "asset.custody_transferred",
    aggregateId: "EPC-1",
    payload: { epc: "EPC-1" },
    createdAt: "2026-07-02T10:00:00.000Z"
  });
  const result = await deliverIntegrationOutbox({
    store,
    tenantId: "hotel-a",
    endpoint: "https://erp.example.test/rfid-events",
    secret: "webhook-secret",
    maxAttempts: 1,
    now: () => Date.parse("2026-07-02T10:01:00.000Z"),
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      text: async () => "maintenance"
    })
  });
  assert.equal(result.deadLettered, 1);
  assert.equal(store.integrationOutboxFor("hotel-a")[0].status, "dead_letter");

  const retried = store.retryIntegrationEvent(
    "hotel-a",
    event.eventId,
    "2026-07-02T10:02:00.000Z"
  );
  assert.equal(retried.status, "pending");
  assert.equal(retried.attempts, 0);
});
