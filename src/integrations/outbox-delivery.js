import { createHmac } from "node:crypto";

export function integrationSignature(secret, timestamp, body) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export async function deliverIntegrationOutbox({
  store,
  tenantId,
  endpoint,
  secret,
  fetchImpl = fetch,
  now = Date.now,
  limit = 100,
  maxAttempts = 5
}) {
  if (!endpoint || !secret) throw new Error("Integration endpoint and secret are required");
  let delivered = 0;
  let failed = 0;
  let deadLettered = 0;
  const events = await store.pendingIntegrationEvents(tenantId, { now: now(), limit });

  for (const event of events) {
    const envelope = {
      id: event.eventId,
      type: event.eventType,
      tenantId: event.tenantId,
      aggregateId: event.aggregateId,
      occurredAt: event.createdAt,
      data: event.payload
    };
    const body = JSON.stringify(envelope);
    const timestamp = String(now());
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-globaltex-event-id": event.eventId,
          "x-globaltex-event-type": event.eventType,
          "x-globaltex-timestamp": timestamp,
          "x-globaltex-signature": `v1=${integrationSignature(secret, timestamp, body)}`
        },
        body
      });
      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`Webhook ${response.status}: ${responseBody.slice(0, 500)}`);
      }
      await store.markIntegrationDelivered(
        tenantId,
        event.eventId,
        new Date(now()).toISOString()
      );
      delivered += 1;
    } catch (error) {
      const updated = await store.markIntegrationFailed(tenantId, event.eventId, error, {
        now: now(),
        maxAttempts
      });
      failed += 1;
      if (updated.status === "dead_letter") deadLettered += 1;
    }
  }

  return {
    attempted: events.length,
    delivered,
    failed,
    deadLettered,
    remaining: (await store.integrationOutboxFor(
      tenantId,
      { status: "pending", limit: 500 }
    )).length
  };
}
