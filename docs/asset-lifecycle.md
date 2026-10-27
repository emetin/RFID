# Textile asset lifecycle

Registered EPC assets use these operational states:

- `active`: available operational inventory;
- `quarantined`: isolated pending inspection or exception handling;
- `damaged`: unusable until repaired or retired;
- `lost`: not currently located;
- `retired`: permanently removed from service.

Every change requires a reason and records the authenticated actor and timestamp
in immutable lifecycle history. Registration creates the first history entry.
Shipment custody transfer creates a new history entry for the receiving tenant.

## Allowed transitions

| Current | Allowed next states |
| --- | --- |
| active | quarantined, damaged, lost, retired |
| quarantined | active, damaged, lost, retired |
| damaged | active, quarantined, retired |
| lost | active, retired |
| retired | none |

Operators may manage active, quarantine, damaged and lost states. Only
`hotel_admin` or `chain_admin` may retire an asset. Retirement is terminal.

## Inventory reporting

`uniqueUnits` remains the physical number of EPCs observed at a location.
`availableUnits` counts only assets in `active` state. `statusCounts` provides
the full active/quarantined/damaged/lost/retired/unregistered distribution.
This prevents quarantined or retired linen from being presented as available
stock while preserving physical traceability.

Every successful transition queues an `asset.status_changed` integration event
and is also covered by API mutation audit history.

## Wash life and PAR stages

A confirmed laundry entry followed by a clean return increments `wash_count`.
A room entry starts one use per clean cycle; room-to-room moves and repeated
reads do not increment `use_count`. At 60 washes the persistent
`inspection_required` flag is set. Configurable SKU service-life rules may
automatically retire active assets at a wash or use limit. The linen operations
API groups current positions into `clean`, `inRoom`, `soiled`, `inWash` and
`other`, and reports when clean stock is below the configured safety margin.

Assets whose last observation is at least 30 days old are returned in the
`notSeen` list and receive a deduplicated `not_seen_30_days` exception.

In-transit items remain traceable at their last observed position but are excluded
from available stock. See [the daily workflow and roadmap](supply-workflow-roadmap.md).
