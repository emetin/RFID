# API reference

## Device authentication

Device calls use:

- `x-device-key`
- `x-device-timestamp`: Unix time in milliseconds
- `x-device-signature`: hexadecimal HMAC-SHA256 of `<timestamp>.<exact request body>`

The timestamp window is five minutes. Device secrets are scoped to one tenant and reader.

## Device endpoints

### `POST /v1/tag-reads`

Accepts the payload in `contracts/tag-read-batch.schema.json`. Returns accepted, duplicate and unknown-asset counts.

### `GET /v1/inventory`

Returns the latest known location of every observed EPC for the device tenant.

### `GET /v1/inventory/summary`

Returns SKU quantities and packaging equivalents. Optional query parameters are `facilityId`, `zoneId` and `sessionId`.

### `GET /v1/movements`

Returns the current MVP movement history.

### `POST /v1/device-heartbeats`

Uses the same device HMAC headers as tag-read ingestion:

```json
{
  "adapter": "llrp",
  "gatewayVersion": "0.1.0",
  "readerConnected": true,
  "queueDepth": 0,
  "lastReadAt": "2026-07-01T17:30:00.000Z",
  "lastError": null,
  "heartbeatAt": "2026-07-01T17:30:05.000Z"
}
```

The server derives tenant and reader identity from the device credential rather
than trusting identifiers in the payload.

## Administrative authentication

The portal provides a custom login page at `/login`. `POST /v1/auth/login`
accepts:

```json
{
  "username": "manager@example.com",
  "password": "assigned-password"
}
```

Successful authentication creates an eight-hour signed HttpOnly, SameSite
session cookie. `POST /v1/auth/logout` expires it. Managed passwords are stored
only as salted `scrypt` hashes. Basic authentication remains supported for
bootstrap credentials and non-browser operational clients.

Production must ultimately replace the local directory with the selected
enterprise identity provider, MFA and auditable identity lifecycle.

The current RBAC foundation can also load `ADMIN_IDENTITIES`. Supported roles:

- `viewer`: read-only tenant dashboards and APIs
- `operator`: read access plus scan-session and shipment-acceptance operations
- `hotel_admin`: full administration inside assigned hotel tenants
- `chain_admin`: full administration across an explicit tenant allowlist

Chain users select an authorized tenant with `x-tenant-id`. Supplying a tenant
outside the identity's allowlist returns `403`.

### `GET /v1/admin/me`

Returns the authenticated actor ID, role, selected tenant and complete tenant
allowlist. The dashboard uses this response to show role context and, when a
user has more than one allowed tenant, a hotel selector.

### `GET /v1/admin/users`

Lists persistent users completely contained within the authenticated
administrator's hotel scope. Viewers and operators cannot access this endpoint.

### `POST /v1/admin/users`

Creates a password-hashed managed user with `username`, `displayName`,
`password`, `role`, `tenantIds` and `defaultTenantId`. A hotel administrator
may assign only the selected hotel and cannot create a chain administrator.
A chain administrator may assign only tenants in their own allowlist.

### `PUT /v1/admin/users/{userId}`

Updates display name, role, hotel assignments, default hotel, active state and
optionally password. Users cannot deactivate their own active session account.
All successful mutations are included in tenant audit history.

## Administrative endpoints

### `GET /v1/admin/chain/summary`

Available only to `chain_admin`. It aggregates inventory across every tenant in
the authenticated identity's explicit allowlist and returns:

- chain totals for unique, registered and unknown units;
- SKU totals with the number of contributing hotel tenants;
- per-tenant inventory and SKU breakdowns.

Packaging equivalents are calculated across the chain when every tenant uses
the same packaging profile for a SKU. If profiles differ, the line is marked
`packagingMixed` and returns the conflicting profiles instead of a misleading
box/pallet total. The endpoint never queries tenants outside the identity
allowlist.

### `POST /v1/admin/facilities`

Creates or updates a tenant-owned hotel, warehouse, factory or laundry:

```json
{
  "facilityId": "hotel-istanbul-1",
  "name": "Istanbul Hotel",
  "facilityType": "hotel",
  "timezone": "Europe/Istanbul",
  "active": true
}
```

`GET /v1/admin/facilities` lists only the authenticated tenant's facilities.

### `POST /v1/admin/zones`

```json
{
  "zoneId": "receiving",
  "facilityId": "hotel-istanbul-1",
  "name": "Receiving",
  "zoneType": "receiving",
  "active": true
}
```

The facility must already exist in the same tenant.
`GET /v1/admin/zones` lists the tenant's zones.

### `POST /v1/admin/readers`

```json
{
  "readerId": "dock-door-1",
  "facilityId": "hotel-istanbul-1",
  "zoneId": "receiving",
  "name": "Dock Door Reader",
  "adapter": "llrp",
  "active": true
}
```

The reader ID must match the `readerId` attached to its device credential.
`GET /v1/admin/readers` lists provisioned readers.

Production rejects tag reads, heartbeats and scan sessions from unprovisioned,
inactive or mismatched reader/location contexts.

### `POST /v1/admin/catalog/import`

Accepts `text/csv` using `data/templates/products.csv`, or JSON:

```json
{
  "products": [{
    "sku": "BT-WHT-2754",
    "name": "Bath Towel",
    "category": "Towels",
    "unitsPerBox": 24,
    "boxesPerPallet": 20,
    "size": "27x54 in",
    "color": "White"
  }]
}
```

### `POST /v1/admin/assets/register`

Accepts `text/csv` using `data/templates/epc-assets.csv`, or JSON:

```json
{
  "assets": [{
    "epc": "3034257BF7194E4000000001",
    "sku": "BT-WHT-2754",
    "tid": null
  }]
}
```

An EPC cannot be silently reassigned to another SKU.

An EPC is globally unique. It cannot be registered independently to a second
tenant. Cross-tenant movement must use the shipment acceptance workflow.

### `GET /v1/admin/assets/{epc}/custody`

Returns the authenticated tenant's dated custody segments for one EPC. Each
segment includes effective `validFrom`/`validTo`, facility, shipment reference
and change type. Supplier custody closes when an accepted shipment transfers
the asset to the hotel; the hotel receives a new open custody segment.

### `GET /v1/admin/assets/{epc}/lifecycle`

Returns the authenticated tenant's status history for an EPC, including the
previous/new state, reason, actor and change time.

### `POST /v1/admin/assets/{epc}/status`

```json
{
  "status": "quarantined",
  "reason": "Visible stain found during receiving"
}
```

Applies a validated asset lifecycle transition and queues an
`asset.status_changed` integration event. Operators cannot set `retired`;
retirement requires `hotel_admin` or `chain_admin` and is terminal. See
[textile asset lifecycle](asset-lifecycle.md).

### `POST /v1/admin/shipments`

Creates an EPC-level manifest owned by the supplier admin tenant:

```json
{
  "shipmentId": "shipment-1001",
  "customerTenantId": "hotel-chain-a",
  "destinationFacilityId": "hotel-istanbul-1",
  "reference": "PO-1001",
  "epcs": [
    "3034257BF7194E4000000001",
    "3034257BF7194E4000000002"
  ]
}
```

Every EPC must currently belong to the supplier tenant.

### `GET /v1/admin/shipments`

Returns shipments where the authenticated tenant is either supplier or
customer. It does not expose unrelated tenants' shipments.

### `GET /v1/admin/shipments/{shipmentId}/reconciliation?sessionId={sessionId}`

Compares the destination hotel's receiving session with the manifest and
returns exact `received`, `missing` and `unexpected` EPC lists and counts.

### `POST /v1/admin/shipments/{shipmentId}/accept`

```json
{
  "sessionId": "receiving-session-id"
}
```

Transfers custody of expected EPCs observed in the receiving session to the
customer tenant. Missing EPCs remain with the supplier. Unexpected EPCs remain
unregistered and visible for exception handling. Repeating acceptance is safe;
already accepted EPCs are not transferred twice.

### `POST /v1/admin/sessions`

```json
{
  "facilityId": "hotel-miami-1",
  "zoneId": "receiving",
  "type": "receiving",
  "reference": "PO-10042"
}
```

Supported types are `receiving`, `inventory`, `transfer`, `laundry_out` and `laundry_in`.

### `POST /v1/admin/sessions/{sessionId}/complete`

Closes an open session. Later retry attempts for already accepted events remain idempotent.

### `GET /v1/admin/catalog`

Returns imported product and packaging rules.

### `GET /v1/admin/sessions`

Returns scan sessions and their unique EPC counts.

### `GET /v1/admin/summary`

Returns inventory totals used by the English dashboard. In addition to physical
`uniqueUnits`, it returns active `availableUnits` and a `statusCounts`
distribution so damaged, lost, quarantined and retired assets remain visible
without being represented as available stock.

### `GET /v1/admin/pending-movements`

Returns zone changes that have not reached the movement confidence threshold.
For unattended reads, a new target zone needs two consistent observations
within 15 seconds. A controlled open scan session is trusted immediately.
Inventory remains at the last confirmed location while evidence is pending.

### `POST /v1/admin/pending-movements/{epc}/resolve`

```json
{
  "action": "confirm"
}
```

An operator may `confirm` or `dismiss` ambiguous movement evidence. Confirming
updates the asset's latest position, appends movement history and creates an
integration outbox event. Dismissing preserves the last confirmed position.
Both actions are automatically audited with the authenticated actor.

### `GET /v1/admin/readers/health`

Returns only readers belonging to the authenticated admin tenant. A current
heartbeat is `online`; a disconnected reader, queued batch or reported error is
`degraded`; no heartbeat received for more than 90 seconds is `offline`.

### `GET /v1/admin/exceptions`

Returns tenant-scoped RFID exception cases. Optional filters are `status`,
`type` and `limit`. Cases are automatically deduplicated for unknown EPC reads
and accepted-shipment missing/unexpected differences.

### `POST /v1/admin/exceptions/{caseId}/resolve`

```json
{
  "resolution": "quarantined"
}
```

Operators and administrators may resolve a case as `corrected`,
`accepted_exception`, `quarantined` or `dismissed`. The actor and timestamp are
retained, the mutation is audited and an `exception.resolved` integration event
is queued. See [RFID exception workflow](exception-workflow.md).

### `GET /v1/admin/retention/read-events`

Requires an ISO-8601 `before` query parameter and accepts an optional batch
`limit` from 1 to 50,000. Returns tenant-scoped raw-read totals, the number
eligible for deletion, and oldest/newest receive times. This endpoint is always
a dry-run and does not delete data.

### `POST /v1/admin/retention/read-events`

```json
{
  "before": "2026-04-01T00:00:00.000Z",
  "limit": 10000,
  "dryRun": false
}
```

Deletes one bounded batch of expired raw reads when `dryRun` is explicitly
`false`. It is restricted to `hotel_admin` and `chain_admin` and automatically
audited. Inventory positions, movement/custody history, sessions, audit and
integration records are preserved. See [RFID data retention](data-retention.md)
for the idempotency and Edge queue safety boundary.

### `GET /v1/admin/audit`

Returns the authenticated tenant's newest administrative mutation events.
Optional `limit` is constrained to 1..500. Events include actor ID, role,
action, entity metadata and server timestamp. Successful admin mutations are
recorded automatically; rejected requests do not create audit events.

### `GET /v1/admin/integrations/outbox`

Returns tenant-scoped ERP/PMS/WMS delivery events. Optional `status` values are
`pending`, `delivered` and `dead_letter`; optional `limit` is capped at 500.

### `POST /v1/admin/integrations/outbox/{eventId}/retry`

Moves a failed or dead-letter event back to the pending queue. Only hotel and
chain administrators can perform this mutation, and the retry is audited.

Webhook deliveries use `x-globaltex-event-id`, `x-globaltex-event-type`,
`x-globaltex-timestamp` and `x-globaltex-signature`. The signature is
HMAC-SHA256 over `<timestamp>.<exact body>`.

### `GET /v1/admin/alerts`

Evaluates and returns tenant-scoped operational alerts. Rules currently cover
offline/degraded readers, movement evidence pending for more than five minutes,
unknown EPCs and integration dead letters. Optional `status` and `limit`
parameters filter the history.

### `POST /v1/admin/alerts/{alertId}/acknowledge`

Allows an operator, hotel administrator or chain administrator to acknowledge
an active alert. The actor is taken from the authenticated identity and the
operation is audited. Alerts resolve automatically when their underlying
condition clears.
