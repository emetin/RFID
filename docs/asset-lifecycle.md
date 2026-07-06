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
