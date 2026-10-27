# RFID supply workflow and acceptance roadmap

Updated: 2026-10-27.

## Local screen review

`npm run start:preview` runs the local portal on port 8085 with a **Test workspace**
dropdown for company administrators. **Hotel portal · demo** renders a disposable,
read-only hotel workspace. Its products, room locations, laundry stages, requests
and incoming delivery exist only in a separate in-memory store. Real account
permissions and customer data remain unchanged. **Back to company** restores the
company view. The server rejects every preview mutation, and production disables
preview regardless of the option or environment flag.

The company overview displays the actual Houston (America/Chicago) and Miami
(America/New_York) warehouse records. Zero stock is shown until tagged goods are
received there. Existing goods at other receiving facilities are reported
separately; defining a warehouse never moves stock.

## Scope

Globaltex receives linen, writes a unique EPC, confirms initial stock, moves goods
through Houston and Miami, ships to assigned hotels, and follows hotel use,
laundry, service life and replenishment. The daily portal exposes five ordered
steps across two separate portals. Technical integration, ERP and standards screens are outside daily work.
Existing records and customer names are preserved.

## Portal ownership

Globaltex is the seller, not a hotel-chain operator. Company administrators manage
their own warehouse inventory, hotel contacts/accounts, outgoing shipments and
customer requests. They cannot switch into hotel inventory or access hotel room,
laundry, lifecycle, stock-policy, reader-health or internal audit endpoints. The
company summary includes only company-owned inventory. Hotel request exports share
SKU, requested quantity, commercial status and delivery progress; internal stock
balances, request-trigger counts and hotel operational history are omitted.

The company portal has four steps: **Hotels & users → Tag & receive products →
Warehouses & transfers → Hotel orders**. Hotel users confirm their own deliveries;
company users can receive only transfers into the company workspace.

The hotel portal has three steps: **Receive deliveries → Locations & laundry →
Request stock**, plus its own inventory/location lookups. It has no tag-writing,
encoding, supplier warehouse, ERP or hotel/customer administration navigation.
Hotel users can submit a manual SKU/quantity request and optionally configure
automatic minimum-stock requests. One open request per SKU prevents duplicates.
Hotel RFID scans use recent observations (within 60 seconds) from the hotel's
assigned gateway at the selected location, or a confirmed manual/scanner count.
Hotel accounts cannot access the physical serial reader attached to Globaltex's
server. The local server reader option belongs only to the company portal.

Hotel managers use **Manage locations → Add location** to create named storage,
receiving, room, soiled, laundry, clean-return and waiting areas within their own
facility. **Locations & laundry** and **Find an item** also link to this page.
Operators/viewers can see their hotel's location directory but cannot create
areas. Duplicate names at the same facility are rejected. Waiting-area movements
do not create uses or washes; an existing laundry cycle remains intact.

Save actions show a pending button state, persistent inline confirmation and a
screen-fixed, dismissible notification. Errors stay next to the form and do not
close its dialog. New products are selected in the RFID product selector after
the catalog refresh. The local demo keeps all save buttons disabled.

## Archive, restore and cancellation

- Globaltex uses **Warehouse inventory → Product catalog → Archive** for unused
  products, and **Warehouses & transfers → Warehouse directory → Archive** for
  empty warehouses. Hotel managers archive their own areas from **Manage locations**.
- Removal is reversible. **Show archived → Restore** returns the same record,
  ID, packaging/time-zone settings and historical links. No RFID, shipment or
  usage history is permanently deleted.
- Non-retired RFID items, queued/leased encoding work, draft receiving batches,
  open scan sessions and relevant open orders/transfers block the corresponding
  archive operation. Errors explain what must be resolved. Retired items remain
  historical evidence and do not by themselves prevent archive.
- Hotel operators/managers may cancel a submitted request within **30 minutes
  of creation**, before Globaltex approval or shipment linkage. The request list
  shows the deadline; the server verifies its own clock and current status.
- At/after the deadline or after approval, the hotel must contact Globaltex.
  Globaltex may cancel approved requests before dispatch; linked shipping and
  receiving states cannot be manually cancelled through this flow.
- Cancellation retains actor/time/history and suppresses immediate automatic
  recreation while stock stays low. Manual resubmission remains possible;
  automatic triggering rearms when stock recovers to the minimum.

Hotel account provisioning remains a company support function. Company accounts
must retain the company root; they cannot be reassigned as company administrators
of customer hotel workspaces. Hotel operations require an actual hotel account.

## Daily operating guide

1. **Hotels & users:** add or edit hotel name, contact, email, phone, address,
   city, state, postal code, country, time zone and notes. Create an assigned
   hotel account. Keep its role limited to the work it performs.
2. **Tag & receive products:** create the SKU and packaging information. Select
   the product and first physical location. Write one tag, verify read-back,
   remove the tag, then repeat. For pre-encoded tags, scan and confirm the
   physical receipt. A generated EPC or failed write is not available inventory.
3. **Warehouses & transfers:** set up Houston and Miami once. Select source,
   destination workspace/facility and order reference. Scan the outgoing EPCs
   and dispatch. Items are in transit and unavailable for another dispatch.
   At the destination, select the transfer and receiving location, scan the
   physical contents and accept. Missing items remain in transit; unexpected
   EPCs are rejected. Partial receipts never complete the whole delivery.
4. **Hotel use & laundry:** add actual room/location names, then scan movements.
   Stock → room starts one use. Room-to-room moves and repeated reads do not
   add uses. Laundry → clean return completes one wash and enables the next use.
   Moving directly into a clean area does not imply washing. Configure per-SKU
   wash/use limits; opt into automatic retirement or review limits manually.
5. **Stock & replenishment:** set minimum/target stock per hotel and SKU. Retired,
   damaged, quarantined, lost and in-transit items do not satisfy available stock.
   A shortage creates one internal request. Globaltex approves it, prepares its
   linked shipment and completes it through verified hotel receiving.

The company portal stays in the company workspace; customer hotels appear as
commercial destinations, not impersonation options. Hotel accounts see only
assigned inventory, transfers, use/laundry and stock rules;
tag writing, hotel/account administration and outbound dispatch are restricted
to Globaltex. Manual EPC entry requires a physical-count confirmation and reason.
It is an operator attestation, not proof from an RFID reader.

## Delivery gates

| Gate | Deliverable | Status / acceptance evidence |
| --- | --- | --- |
| 1. One daily portal | Five numbered steps, hotel editing and contextual actions | Implemented; overview, transfers and hotel editing verified in the browser |
| 2. Warehouse journey | Houston/Miami setup, same-owner transfers, in-transit availability, partial receipt | Automated memory/SQLite end-to-end and restart tests |
| 3. Hotel journey | Assigned accounts, receiving, room/laundry scans, use/wash counters | Automated tenant, role and cycle tests |
| 4. Service life | Configurable SKU limits, optional automatic retirement, internal replenishment | Automated retirement-to-shortage-to-request test |
| 5. Reader acceptance | Real tag writing/read-back, bulk reads, correct direction/location and offline recovery | Pending connected writer/readers and representative linen |
| 6. Production acceptance | PostgreSQL migration 015, live database tests, HTTPS deployment and restore drill | Requires configured production-like infrastructure |

## Physical pilot, in order

1. Connect and identify the encoding reader/writer. Verify the local RF region
   and tag compatibility. Write and read back a small controlled linen batch.
2. Assign receiving/exit readers to actual Houston and Miami zones. Compare
   EPC manifests with manual counts for each dispatch and receipt.
3. Create one real hotel and assigned user. Verify a partial delivery followed
   by the remaining receipt, including an unexpected-tag rejection.
4. Install room/linen-room and laundry observation points, or define a handheld
   scan procedure. Confirm that one real use and one wash are counted exactly once.
5. Set agreed service-life and minimum-stock policies. Verify retirement and
   the approval → dispatch → receipt sequence using a dedicated test batch.
6. Run live PostgreSQL tests and backup/restore checks before real multi-site use.

RFID reports the last confirmed observation point; it is not continuous GPS.
Actual room entry cannot be inferred without a reader or operator scan.
Service-life rules do not physically remove goods: retired items remain
traceable and must be removed from circulation by staff.

## Explicit boundaries

- Automatic replenishment creates an internal request, not a legally binding
  purchase order, payment or external ERP order.
- Default stock/laundry locations are operational categories. Add real room
  numbers before room-level use; no physical location is inferred from its name.
- Failed tag writes create failed encoding jobs and never available stock.
  A verified tag followed by a server failure must be recovered by reading the
  existing tag and confirming receipt, rather than writing it again blindly.
- Existing wash counts are preserved; their earlier counting semantics cannot
  be reconstructed retrospectively from the current counter alone.
- Native PostgreSQL changes are included but require a live database to qualify.

Company service-life rules are inherited on workflow receiving when the hotel
has no existing rule for that SKU. A hotel-specific rule takes precedence.

## Operational hotel areas and hotel details
New hotels use Storage, Washing, Drying, Distribution and In Use. Guest-room tracking is not required. Legacy zone identities remain available for history. Washing followed by drying and storage completes one wash; entering general use after a clean cycle counts one use. Hotel details contains separate contact records and login accounts. Contacts support add/edit/recoverable removal/restore, while login access uses existing edit and enable/disable controls. Removing a contact never changes access permissions. Lists are scoped to the chosen hotel and paged in groups of ten.
