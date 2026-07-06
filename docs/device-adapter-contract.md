# Device adapter contract

The Edge Gateway is the only hardware-specific part of the platform. A reader adapter must:

1. connect to one reader using MQTT, HTTP, LLRP or a vendor SDK;
2. normalize every observation to `eventId`, uppercase hexadecimal `epc`, `observedAt`, optional `rssi` and `antenna`;
3. keep the same `eventId` when retrying after a network failure;
4. batch at most 5,000 observations;
5. build the normalized batch once, preserving its generated event IDs;
6. persist it through `OfflineQueue` before attempting cloud delivery;
7. flush queued batches through `sendBatch`, deleting only after a successful response;
8. expose connection, queue-depth and last-read health metrics.

The adapter reports these metrics through the signed
`POST /v1/device-heartbeats` endpoint. Production adapters should send a
heartbeat more frequently than the 90-second offline threshold, independently
of whether tags are currently being observed.

Canonical payloads are defined by `contracts/tag-read-batch.schema.json`.

## Adapter acceptance test

An adapter is accepted only when it passes:

- reconnect after reader restart;
- cloud outage with no event loss;
- retry without duplicate inventory;
- timestamp synchronization;
- EPC normalization;
- sustained expected tag throughput;
- graceful handling of malformed reader messages.

Until hardware is selected, `simulate` and `stdin` are the reference adapters. A vendor adapter must produce the same payload; no cloud or inventory code should change.

The executable plugin contract, built-in registry, integration-family catalog,
vendor template and conformance command are documented in
[RFID Adapter SDK](adapter-sdk.md).

## Offline queue behavior

The reference CLI writes every batch to SQLite before network delivery. Failed
batches remain ordered on disk and keep their original event IDs across process
restarts. Synchronization stops at the first failed batch so later observations
cannot overtake earlier ones.

Set `EDGE_QUEUE_KEY` to encrypt payloads with AES-256-GCM. This setting is
mandatory in production. Losing or changing the key makes existing encrypted
batches unreadable, so it must be stored and rotated through the deployment's
secret-management process.
