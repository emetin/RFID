# RFID product and usability review

Review date: 2026-10-27. Scope: Globaltex-owned stock, Houston/Miami distribution, customer hotel receiving, private hotel operations and replenishment.

## Evidence and limits

This review compares the local source, tests and existing roadmaps with public project documentation. External repositories were inspected as architectural references, not installed, executed or certified. A README feature is not evidence of production reliability. Recommendations below are product judgments, not features guaranteed by external projects.

References:
- sllurp: https://github.com/sllurp/sllurp — LLRP reader interface and antenna/RSSI/time/read-count metadata.
- EdgeX RFID inventory: https://github.com/edgexfoundry/app-rfid-llrp-inventory
- EdgeX inventory events: https://docs.edgexfoundry.org/4.0.2/microservices/application/services/AppLLRPInventory/details/InventoryEvents/ — observed arrival/departure/age-out semantics.
- GS1 EPCIS: https://www.gs1.org/standards/epcis — business event context and aggregation.
- Fosstrak historical export: https://github.com/Fosstrak/fosstrak — explicitly unsuitable as a new implementation dependency.

## Existing foundation: expose and qualify rather than rebuild

Local modules/tests already cover event idempotency, movement confidence, offline queues, receiving reconciliation, lifecycle transitions, custody, integration outbox, alerts, backup snapshots and basic EPCIS event generation. These do not establish hardware accuracy or production acceptance. The current roadmap still requires connected-reader and live PostgreSQL qualification. Company visibility must stop at commercial orders and receipt confirmations after hotel custody transfer.

## Ordered backlog

| Priority | Deliverable | Gap category | Acceptance |
| --- | --- | --- | --- |
| P0 | Product workspace: editable metadata, stock, location breakdown and shipment history | Daily UI incomplete | Change allowed metadata without changing SKU/EPC identity; scoped history links reconcile to manifests |
| P0 | Guided count and discrepancy resolution | Existing technical foundation needs daily UI | Scan a zone; review expected/read/missing/unexpected; approve with actor/reason; repeat submission is safe |
| P0 | Reader setup and qualification wizard | Hardware verification pending | Identify device, assign zone, write/read back, test a representative batch; distinguish port availability from valid reads |
| P0 | Server-side query, filtering, sorting and pagination | Current list views still fetch all source rows | Stable ordering and bounded response size; realistic load test; filter changes reset cursor/page; enforce tenant scope before search |
| P0 | Unified responsive components | Current CSS accumulated overrides | Shared fields/buttons/table/list/dialog; consistent dimensions; test 360/390/768/1024/1440 widths, keyboard and long text |
| P1 | EPC replacement with history | Product workflow requires design and implementation audit | Retire old tag link, verify new tag; preserve physical item history and prohibit duplicate active identity |
| P1 | Returns and quarantine approval | Existing lifecycle is not a complete commercial return process | Request, approve, scan return, inspect, accept or reject; custody and stock change only at the authorized step |
| P1 | Hotel clean-stock coverage | Current available stock includes circulating active linen | Separate usable total from immediately clean stock; display stage counts and configurable replenishment basis |
| P1 | Order preparation and partial fulfillment workspace | Existing dispatch/receipt flow needs clearer operator steps | Prevent double allocation; show committed/remaining units; document cancelability for each state |
| P1 | Actionable exception inbox | Existing exceptions/alerts need unified daily view | Filter by site/severity/owner; open evidence; resolve with reason; retain audit history |
| P1 | Verified use/wash/retirement analytics | Existing movement-based rates have limited meaning | Persist cycle-completion and retirement events; rate labels match events; do not equate room entries with consumption |
| P2 | Reorder forecast and supplier lead time | Requires reliable historical series | Show data window, actual retirements/losses, lead time and uncertainty; never infer exhaustion from repeated laundry scans |
| P2 | Case/cart/pallet aggregation | Useful after real dispatch volume is measured | Parent-child membership verified at packing; exceptions invalidate automatic receipt assumptions |
| P2 | Rich catalog and import preview | Optional product-management expansion | Image, dimensions/material/category; CSV validation preview and duplicate handling before commit |

## Interface structure

- Company: Overview / Products / Warehouses & Transfers / Hotels & Orders / Devices / Reports.
- Product detail: Overview / Inventory / Transfers / Activity / Settings. Only authorized master-data editors see Settings.
- Hotel: Overview / My Linen / Receive / Locations & Laundry / Stock Requests / Reports. No manufacturing/tag-writing UI.
- Mobile: one primary action per screen; compact summary rows; secondary actions in detail views; filters in a compact expandable region; persistent filter summary and clear reset.
- Replace repeated catalog and stock-summary lists with a unified product entry point and distinct detail tabs.
- Show business names and counts first; EPC and device diagnostics on demand. Preserve original submitted product/customer casing.

## Delivery order

1. Product edit/history, server-backed lists and component consolidation.
2. Count/reconcile inbox, device wizard and connected-reader pilot.
3. Tag replacement, return/quarantine and clean-stock rules.
4. Verified lifecycle analytics, then forecast/aggregation if evidence supports them.

Production readiness additionally requires live PostgreSQL qualification, deployment/auth configuration, role-isolation checks, concurrent dispatch/receipt testing and a measured restore drill. Existing tests and backup code are foundations, not substitutes for these exercises.
