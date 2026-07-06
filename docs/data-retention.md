# RFID data retention

## What is deleted

The retention operation deletes only expired rows from `read_events`: the raw,
high-volume observations received from readers. It does not delete:

- current inventory positions;
- confirmed movement history or pending movement evidence;
- scan sessions and their unique EPC counts;
- product, asset, shipment or custody records;
- audit history, alerts or integration outbox events.

This separation keeps operational and compliance history useful while bounding
the fastest-growing table.

## Safe operating procedure

Preview the exact tenant scope before every execution:

```http
GET /v1/admin/retention/read-events?before=2026-04-01T00:00:00.000Z&limit=10000
```

The response reports total and eligible rows without deleting anything. Execute
one bounded batch with a `hotel_admin` or `chain_admin` identity:

```http
POST /v1/admin/retention/read-events
Content-Type: application/json

{
  "before": "2026-04-01T00:00:00.000Z",
  "limit": 10000,
  "dryRun": false
}
```

Repeat until `eligible` reaches zero. Each successful POST is added to the
tenant audit log. The batch limit is restricted to 1–50,000 rows so cleanup
does not create one unbounded database transaction.

## Idempotency boundary

`eventId` duplicate protection is stored with the raw read. Once a raw read is
purged, replaying that old event ID can be accepted again. Therefore:

- keep raw reads longer than the maximum Edge Gateway offline/retry window;
- never purge while an old Edge queue is still awaiting synchronization;
- verify queue depth and reader health before executing retention;
- use at least 30–90 days for pilots unless a customer policy requires longer.

Movement, custody, session, audit and integration records remain intact even
when the originating raw reads expire. The production retention period must be
approved with the hotel chain's legal, security and integration owners.
