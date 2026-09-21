# Customer onboarding and integrations

Hotels must be able to start without an ERP integration while larger customers
can automate the same contracts. The platform therefore supports three catalog
entry paths that converge on one tenant-scoped product model:

1. manual product entry in the dashboard;
2. product and EPC mapping CSV imports;
3. authenticated API connectors for Zoho, ERP, WMS or hotel inventory systems.

## Opening inventory sequence

1. Select the hotel tenant.
2. Create or import SKU, name, category and packaging rules.
3. Encode new tags or import existing `EPC -> SKU` mappings.
4. Run a controlled baseline scan for every facility and zone.
5. Resolve unregistered, missing and unexpected EPCs.
6. Approve the baseline as the opening physical inventory.

An ERP quantity is a book balance. RFID inventory is the count of unique,
accepted EPCs observed in the physical operation. Differences must be displayed
for reconciliation and must not silently overwrite either system.

## Existing API surface

- `GET /v1/admin/catalog`: list the selected hotel's product master.
- `POST /v1/admin/catalog/import`: upsert products using JSON or CSV.
- `POST /v1/admin/assets/register`: register EPC-to-SKU mappings using JSON or CSV.
- `GET /v1/admin/summary`: read physical, registered and available RFID totals.
- shipment, session and webhook endpoints provide operational synchronization.

The customer integration API now provides tenant-scoped Bearer credentials,
explicit scopes, rate limiting, mandatory idempotency keys and audit history.
Production deployment must keep tokens in a secret manager, establish a token
rotation procedure and expose the service only through HTTPS. Outbound webhooks
remain separately signed by the tenant integration configuration.

## Connector responsibility

ERP, Zoho or WMS remains the source for product and purchasing master data.
Globaltex RFID remains the source for EPC identity, physical observation,
location, lifecycle state and RFID exceptions. Connectors translate external
records into the common catalog API instead of adding vendor-specific inventory
logic to the RFID core.
