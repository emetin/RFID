# Enterprise RFID product roadmap

## Current maturity

The repository is a Phase 0 technical prototype. It proves that a registered EPC
can be accepted securely, deduplicated and shown in the correct tenant's latest
inventory. It is not yet a production platform for a hotel chain.

Passing the current automated tests means the prototype contract works. It does
not prove reader accuracy, movement accuracy, production scale, disaster
recovery, hotel-system integration or operational readiness.

## Required business flow

The first production vertical slice is:

```text
Globaltex product and EPC registration
  -> shipment created for a hotel-chain tenant and destination hotel
  -> EPC manifest attached to shipment
  -> receiving reader or handheld scans the delivery
  -> expected / read / missing / unexpected EPC reconciliation
  -> authorized operator accepts exceptions
  -> custody is transferred to the hotel
  -> items become visible in hotel inventory
  -> every later movement remains auditable
```

An EPC read is an observation, not automatically a stock movement. Movement is
confirmed only after the configured time window, antenna/direction evidence and
confidence threshold are satisfied, or after an operator resolves an exception.

## Enterprise domain model

- `tenant`: hotel chain, independent hotel or Globaltex operating account
- `facility`: hotel, Globaltex warehouse, distribution center or laundry
- `zone`: receiving, linen room, floor store, laundry out/in or quarantine
- `user`, `role`, `scope`: chain, hotel and zone-level authorization
- `reader`, `antenna`, `gateway`: provisioned hardware and health state
- `catalog_product`: Globaltex item definition and packaging rules
- `asset`: globally unique EPC and immutable product identity
- `asset_custody`: current tenant/facility responsibility with effective dates
- `shipment`, `shipment_line`, `shipment_asset`: expected delivery manifest
- `read_event`: immutable raw reader observation
- `movement_candidate`: time-window aggregation and direction evidence
- `movement_event`: confirmed business movement with confidence and source
- `inventory_session`: controlled handheld or portal count
- `inventory_snapshot`: point-in-time inventory result and variance
- `exception_case`: unknown, missing, duplicate, cross-tenant or ambiguous read
- `integration_outbox`: retry-safe ERP/PMS/WMS delivery
- `audit_event`: actor, action, previous value, new value and correlation ID

The EPC must be globally unique in the platform. Tenant isolation controls who
can see an asset; it must not permit the same EPC to be independently registered
as two unrelated physical items.

## Product workstreams

### 1. Hotel-chain control plane

- chain, hotel, laundry, zone and reader provisioning
- SSO/OIDC, MFA and role-based access
- chain-wide and hotel-scoped dashboards
- reader/gateway certificate rotation and remote configuration

### 2. Shipment and custody

- purchase order and ASN references
- EPC-level shipment manifests
- receiving reconciliation: expected, received, missing and unexpected
- explicit custody transfer and rejection/quarantine workflows
- returns and inter-hotel transfers

### 3. Reliable edge ingestion

- real LLRP/vendor adapter
- encrypted disk-backed offline queue
- stable event IDs across retries
- heartbeat, clock drift, queue depth and antenna health telemetry
- remote diagnostics and safe software updates

### 4. Movement intelligence

- configurable read windows and duplicate suppression
- portal direction from antenna sequence and GPIO/beam sensors where available
- RSSI thresholds and site-specific calibration profiles
- confidence scoring and ambiguous-read review queue
- prevention of impossible or stale movements

### 5. Hotel operations

- receiving, linen-room, laundry-out, laundry-in and cycle-count workflows
- handheld search for a missing item
- par-level, shrinkage, aging and wash-cycle reports
- damaged, lost, retired and quarantine lifecycle
- alerts and scheduled reports

### 6. Integrations and platform operations

- versioned REST/webhook APIs and per-customer connector mappings
- transactional outbox, retries and dead-letter handling
- PostgreSQL production persistence, backups and point-in-time recovery
- queue/event bus for burst traffic
- observability, alerting, SLOs and incident runbooks
- regional hosting, retention, privacy and security controls

## Delivery gates

### Phase 1 - shipment-to-hotel inventory

Deliver the complete business flow above using a simulator, with tenant-safe
APIs and automated acceptance tests.

Exit criteria:

- a shipment manifest can contain thousands of unique EPCs
- the destination tenant cannot see assets before authorized assignment
- receiving reports exact missing and unexpected EPCs
- accepted assets appear in the destination hotel's inventory
- duplicate requests and retries cannot duplicate stock or custody events
- every transfer and exception has an audit record

### Phase 2 - controlled hardware pilot

Add one selected fixed reader and one handheld adapter, offline queue, device
monitoring and calibrated movement confirmation.

Exit criteria:

- no data loss during a tested internet outage
- controlled portal read rate meets the agreed target
- false movement rate is at or below the pilot threshold
- manual and RFID inventory are reconciled for at least two weeks

### Phase 3 - first hotel-chain production

Add enterprise identity, the customer's ERP/PMS/WMS connector, production
hosting, support processes and multi-hotel reporting.

Exit criteria:

- security and disaster-recovery tests pass
- customer acceptance scenarios pass end to end
- support ownership and incident response are agreed
- rollout and rollback procedures are exercised

## Decisions needed from the first customer

- hotel chain, pilot property and country
- existing ERP/PMS/WMS and its API or file interface
- fixed portals, handhelds and encoding hardware to be used
- required zones and operational movement meanings
- who owns an item and when custody transfers
- expected daily read volume and inventory size
- retention, hosting region, identity provider and reporting requirements

