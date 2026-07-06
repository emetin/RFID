# Globaltex RFID Platform

> **Maturity:** Phase 0 technical prototype. The EPC ingestion and inventory
> foundation works, but this repository is not yet a production-ready hotel
> chain platform. See the [enterprise product roadmap](docs/enterprise-roadmap.md).

Globaltex textile products can be tracked across hotels, warehouses and laundries with item-level RFID reads. The application derives box and pallet equivalents from unique tagged-unit counts and remains independent of a specific reader brand.

## How it works

An EPC Class 1 Gen2 / ISO 18000-63 reader can read the unique EPC stored on a compatible UHF tag. Reader data reaches the Edge Gateway through MQTT, HTTP, LLRP or a vendor SDK. The Gateway converts every device format into one Globaltex event contract.

Only a unique EPC belongs on the tag. Product, customer, hotel, quantity and location data remain in the database:

```text
RFID tag EPC -> registered asset -> product SKU -> current inventory position
```

The EPC remains the same when a product is encoded in Türkiye and used in the
United States. The encoding station and hotel reader use different local RF
profiles: `ETSI_TR` in Türkiye and `FCC_US` in the United States. RF-emitting
adapters fail closed when a supported region is not configured.

## Running preparation

- HMAC-authenticated reader ingestion
- tenant-separated inventory
- retry-safe `eventId` idempotency
- EPC-to-SKU registration and unknown-tag detection
- EPC-level hotel shipment manifests and receiving reconciliation
- accepted-asset custody transfer from supplier to hotel tenant
- dated EPC custody ledger with shipment and facility history
- receiving, inventory and transfer scan sessions
- latest location and movement history
- confidence-gated unattended zone changes and a movement review queue
- persistent unknown/missing/unexpected EPC cases with operator resolution
- audited textile lifecycle states and available-vs-physical inventory totals
- signed Gateway heartbeat with online, degraded and offline reader health
- tenant-scoped hotel, zone and reader provisioning with assignment enforcement
- viewer/operator/hotel-admin/chain-admin RBAC and tenant-scoped audit history
- allowlisted chain-admin multi-hotel inventory and SKU rollup
- transactional ERP/PMS/WMS outbox with signed webhooks, retry and dead-letter handling
- deduplicated operational alerts with acknowledgement and automatic resolution
- verified SQLite snapshots with SHA-256 manifests and a controlled restore runbook
- tenant-scoped raw-read retention preview and bounded purge
- automatic full-pallet, remaining-box and loose-unit calculations
- English operations dashboard
- CSV-ready product templates
- production PostgreSQL schema with row-level tenant isolation
- hardware-free reader simulator
- versioned RFID Adapter SDK with manifest/config validation and conformance testing
- Node.js 24 or newer with no runtime package installation

```powershell
npm test
npm run demo
```

The demo registers a sample product and three EPC assets, runs a receiving scan through the Edge Gateway and prints the resulting unit/box/pallet summary. Automated platform tests additionally cover a supplier-to-hotel shipment with missing and unexpected EPC reconciliation.

## Local SQLite API and dashboard

No account, Docker installation or external database is required. Start the API:

```powershell
npm run start:api
```

The persistent SQLite database is created at `data/runtime/rfid.db`. On the first local start, sample products and five EPC assets are registered automatically.

Open `http://127.0.0.1:8080/dashboard` and sign in with:

```text
username: admin
password: local-admin
```

In another terminal, run the hardware-free reader:

```powershell
npm run gateway:simulate
```

Refresh the dashboard to see five units represented as one full pallet and one loose unit. Run the simulator again to verify retry-safe inventory: new read events increase read counts, while unique inventory remains five units.

The Gateway writes batches to `data/runtime/edge-queue.db` before delivery. If
the API is unavailable it reports `queued_offline`; running it again after the
API returns flushes the retained batches in order with the original event IDs.
Set `EDGE_QUEUE_KEY` to encrypt the queue. Production mode refuses to start the
Gateway without this key.

Production mode does not permit these development credentials. Set `NODE_ENV=production` and provide the secrets from `.env.example` before deployment.

### Multi-hotel users and hotel selection

The dashboard reads the authenticated actor, role and hotel allowlist from
`ADMIN_IDENTITIES`. A user assigned to multiple tenants gets a hotel selector;
a `chain_admin` also sees chain-wide inventory totals. Each API request is still
executed inside the selected tenant boundary.

Example:

```powershell
$env:ADMIN_IDENTITIES='{
  "chain-secret":{"actorId":"chain.ops@example.com","role":"chain_admin","tenantIds":["hotel-a","hotel-b"],"defaultTenantId":"hotel-a"},
  "hotel-a-secret":{"actorId":"manager.a@example.com","role":"hotel_admin","tenantIds":["hotel-a"]},
  "viewer-secret":{"actorId":"auditor@example.com","role":"viewer","tenantIds":["hotel-a","hotel-b"],"defaultTenantId":"hotel-a"}
}'
npm run start:api
```

Use `admin` as the bootstrap username and the object key as its password/token.
After signing in, hotel and chain administrators can create persistent users,
assign one or more allowed hotels, change roles, reset passwords and
enable/disable accounts from the dashboard. Passwords are stored as salted
`scrypt` hashes and browser sessions use signed HttpOnly cookies.

`ADMIN_TOKEN` / `ADMIN_IDENTITIES` remain bootstrap and emergency-access
credentials; they are not displayed in the managed-user table. Enterprise
production will replace this local directory with the selected OIDC/SAML
identity provider while retaining the same role and tenant authorization model.

The `stdin` adapter accepts one normalized device read per line:

```json
{"epc":"3034257BF7194E4000000001","rssi":-47.2,"antenna":1}
```

## Local PostgreSQL Docker stack

Start the PostgreSQL-backed API, migration job and database:

```powershell
docker compose up -d --build api
```

Open `http://127.0.0.1:8081/dashboard` with `admin` / `local-admin`.
This is separate from the SQLite development portal on port 8080.

Check or stop the stack:

```powershell
docker compose ps
docker compose down
```

Run the complete test suite, including the live PostgreSQL tests:

```powershell
$env:TEST_POSTGRES_URL="postgresql://globaltex:local-development-only@127.0.0.1:5432/globaltex_rfid"
npm test
```

Without `TEST_POSTGRES_URL`, the four live PostgreSQL tests are intentionally
skipped while the remaining local tests still run.

The named PostgreSQL volume survives `docker compose down`. Do not add `-v`
unless intentionally deleting the local database.

## Product list integration

The final product list uses [the CSV template](data/templates/products.csv):

```csv
sku,name,category,units_per_box,boxes_per_pallet,size,color
BT-WHT-2754,Bath Towel,Towels,24,20,27x54 in,White
```

No application code changes when the real list arrives. Upload the file to `POST /v1/admin/catalog/import` with content type `text/csv`. EPCs produced by an encoding station or tag supplier are then registered against a SKU. [The sample EPC file](data/templates/epc-assets.csv) defines that handoff format.

## Prepared integration boundaries

- Reader-to-cloud payload: [JSON Schema](contracts/tag-read-batch.schema.json)
- HTTP endpoints and authentication: [API reference](docs/api.md)
- Reader adapter requirements: [device adapter contract](docs/device-adapter-contract.md)
- Multi-vendor plugin development: [RFID Adapter SDK](docs/adapter-sdk.md)
- Tag writing process: [encoding workflow](docs/encoding-workflow.md)
- Production persistence: [PostgreSQL migration](db/migrations/001_initial.sql)
- Preparation status: [readiness checklist](docs/readiness-checklist.md)
- Hardware purchasing criteria: [hardware compatibility](docs/hardware-compatibility.md)
- Türkiye-to-US RF configuration: [regional deployment](docs/regional-rf-deployment.md)
- Pilot execution: [pilot plan](docs/pilot-plan.md)
- Reader/writer qualification: [hardware pilot runbook](docs/hardware-pilot-runbook.md)
- Enterprise build-out: [product roadmap](docs/enterprise-roadmap.md)
- Backup and restore: [disaster recovery runbook](docs/disaster-recovery.md)
- Raw RFID data lifecycle: [data retention runbook](docs/data-retention.md)
- RFID exception operations: [exception workflow](docs/exception-workflow.md)
- Textile status operations: [asset lifecycle](docs/asset-lifecycle.md)
- PostgreSQL preparation: [deployment guide](docs/postgresql-deployment.md)

## Current boundary

Local records persist in SQLite after restart. SQLite is intended for development and a single-computer pilot. The PostgreSQL store, migration runner, connection pool, RLS-safe tenant boundary and Docker deployment stack are implemented and covered by live local integration tests. A real reader adapter, enterprise identity provider and customer-specific ERP/PMS certification still depend on the selected hardware and customer environment.
