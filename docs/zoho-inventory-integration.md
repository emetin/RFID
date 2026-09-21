# Zoho Inventory integration runbook

## Phase 1: Zoho preparation

1. Confirm the Zoho Inventory plan, organization ID and account data center. This deployment uses organization `657492287` in the `.com` data center.
2. Confirm that every tracked product has a unique SKU.
3. Create or verify locations for the factory, warehouses, hotels and laundries when the Zoho plan and user permissions support the Locations API. This deployment currently keeps `ZOHO_LOCATIONS_ENABLED=false` and skips location synchronization.
4. Decide whether EPC values will also be managed as Zoho serial numbers. Do not enable this before a representative-volume pilot.
5. In the Zoho API Console, create a server-based client with the production callback URL.
6. Authorize only the required scopes:
   - `ZohoInventory.items.READ`
   - `ZohoInventory.settings.READ`
   - `ZohoInventory.inventoryadjustments.CREATE`
   - `ZohoInventory.inventoryadjustments.READ`
   - `ZohoInventory.transferorders.CREATE`
   - `ZohoInventory.transferorders.READ`
   - `ZohoInventory.transferorders.UPDATE`
7. Generate an offline grant and store the refresh token in a secret manager. Never commit it to Git.

## Phase 2: Read-only connection check

Set the `ZOHO_*` environment variables documented in `.env.example`, then run:

```powershell
npm run zoho:check
```

The command refreshes an access token, verifies the organization and reads active and inactive item pages. It lists locations only when `ZOHO_LOCATIONS_ENABLED=true`. It does not modify Zoho stock or product status.

Generate the read-only RFID eligibility and mapping report with:

```powershell
npm run zoho:mapping-report
```

The dashboard catalog report retains active and inactive physical goods with inventory tracking enabled and a non-empty SKU. Only active, uniquely identified goods are eligible for encoding. Runtime JSON and CSV outputs are ignored by Git.

## Phase 3: Mapping approval

Export and review these mappings before enabling writes:

- RFID `sku` -> Zoho `item_id`
- RFID `facility_id` -> Zoho `location_id`
- optional RFID `zone_id` -> Zoho bin/storage ID

Missing or duplicate SKUs and unmapped facilities must fail closed.

## Phase 4: Controlled writes

Enable one document type at a time in a sandbox/test organization:

1. Completed RFID stock count -> one quantity inventory adjustment, initially without location-level routing.
2. Confirmed cross-facility movement -> transfer order only after Locations API access is enabled; until then movements remain in the RFID platform.
3. Optional EPC tracking -> Zoho serial numbers through supported stock transactions.

Every write must carry the RFID outbox event ID in `reference_number` or a custom field. Before retrying after a timeout, search for that reference to prevent a duplicate document.

## Phase 5: Zoho-to-RFID updates

Configure Zoho workflow webhooks for the supported modules and point them to a public HTTPS endpoint on the RFID API. Validate a shared secret, retain the received event ID, and periodically reconcile items and locations because workflow coverage is not a complete change-data feed.

## Production gates

- OAuth secrets are held outside `.env` files and source control.
- 429 responses use backoff and daily usage is monitored.
- No raw RFID read is sent to Zoho; only confirmed, grouped business movements are sent.
- A dead-letter queue and manual retry remain available.
- Reconciliation compares Zoho quantity by item/location with RFID unique EPC totals.
