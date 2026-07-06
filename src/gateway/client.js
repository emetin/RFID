import { randomUUID } from "node:crypto";
import { signatureFor } from "../core/auth.js";

export function normalizeRead(read, observedAt = new Date().toISOString()) {
  const epc = String(read.epc ?? "").replace(/\s/g, "").toUpperCase();
  return {
    eventId: read.eventId ?? randomUUID(),
    epc,
    observedAt: read.observedAt ?? observedAt,
    ...(read.rssi == null ? {} : { rssi: Number(read.rssi) }),
    ...(read.antenna == null ? {} : { antenna: Number(read.antenna) })
  };
}

export function buildReadBatch({ facilityId, zoneId, sessionId, reads }) {
  return {
    facilityId,
    zoneId,
    ...(sessionId ? { sessionId } : {}),
    events: reads.map((read) => normalizeRead(read))
  };
}

export async function sendBatch({
  apiUrl,
  deviceKey,
  deviceSecret,
  batch,
  fetchImpl = fetch,
  now = Date.now
}) {
  const body = JSON.stringify(batch);
  const timestamp = String(now());
  const response = await fetchImpl(`${apiUrl}/v1/tag-reads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-key": deviceKey,
      "x-device-timestamp": timestamp,
      "x-device-signature": signatureFor(deviceSecret, timestamp, body)
    },
    body
  });

  const result = await response.json();
  if (!response.ok) throw new Error(`RFID API ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

export async function sendHeartbeat({
  apiUrl,
  deviceKey,
  deviceSecret,
  heartbeat,
  fetchImpl = fetch,
  now = Date.now
}) {
  const body = JSON.stringify(heartbeat);
  const timestamp = String(now());
  const response = await fetchImpl(`${apiUrl}/v1/device-heartbeats`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-key": deviceKey,
      "x-device-timestamp": timestamp,
      "x-device-signature": signatureFor(deviceSecret, timestamp, body)
    },
    body
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`RFID API ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

export async function sendReads({
  apiUrl,
  deviceKey,
  deviceSecret,
  facilityId,
  zoneId,
  sessionId,
  reads,
  fetchImpl = fetch,
  now = Date.now
}) {
  return sendBatch({
    apiUrl,
    deviceKey,
    deviceSecret,
    batch: buildReadBatch({ facilityId, zoneId, sessionId, reads }),
    fetchImpl,
    now
  });
}
