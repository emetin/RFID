# RFID exception workflow

## Automatically created cases

The platform creates tenant-scoped, deduplicated exception cases for:

- `unknown_asset`: an observed EPC is not registered to the reading tenant;
- `shipment_missing`: an expected manifest EPC was not in the accepted receiving session;
- `shipment_unexpected`: a receiving session contained an EPC outside the manifest.
- `wash_threshold`: an asset reached its configured inspection threshold;
- `not_seen_30_days`: a positioned asset has not been observed for 30 days.

Repeated reads of the same unknown EPC update one case instead of creating an
unbounded case stream. Shipment cases use shipment, session, exception type and
EPC as their idempotency key, so retrying acceptance does not duplicate cases.

When shipment acceptance transfers a previously unknown expected EPC into the
hotel tenant, its `unknown_asset` case is automatically resolved as `corrected`.
Missing and unexpected shipment cases remain open for an operator.

## Operator handling

List cases with optional filters:

```http
GET /v1/admin/exceptions?status=open&type=shipment_missing&limit=100
```

Resolve one case:

```http
POST /v1/admin/exceptions/{caseId}/resolve
Content-Type: application/json

{
  "resolution": "quarantined"
}
```

Supported resolutions are:

- `corrected`
- `accepted_exception`
- `quarantined`
- `dismissed`
- `reassigned_property`
- `misplaced`
- `quarantine_bill`

Resolution records the authenticated actor, timestamp and resolution, adds the
API mutation to the audit log, and writes an `exception.resolved` integration
outbox event. Repeating a completed resolution is idempotent.

`quarantine_bill` also moves a registered asset into the `quarantined`
lifecycle state. Billing remains an integration/outbox concern; the dashboard
records the billing-review decision and does not fabricate an invoice.
