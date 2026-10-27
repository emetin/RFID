# Company and hotel reports

Open **Reports** from either portal. Reports use the signed-in workspace and the
same server-side company/customer privacy boundary as the operational screens.

## Company view

- Current company item inventory, availability, in-transit stock and condition.
- Product and facility/location summaries, including archived master records.
- Confirmed company location events with source, destination, EPC and reader.
- Customer request quantities, commercial statuses and linked delivery progress.
- Transfers, partial receiving, outstanding items and time to full receipt.
- Customer order performance, product demand/dispatch/receipt activity and daily trends.
- Current stale observations, unregistered tags and damaged/lost/quarantined items.

Company reports never query customer inventory, room movements, wash/use counters,
minimum-stock settings or private operational history. Customer request exports
omit internal stock-at-trigger values and internal request history.

## Hotel view

- The hotel's own items, product and location summaries, condition and availability.
- Room/laundry/waiting-stage details and lifetime use/wash counters on current items.
- Confirmed hotel location events, incoming shipments and receiving progress.
- The hotel's own requests and daily activity.
- Hotel-wide available stock, minimum/target rules, shortages, suggested request
  quantities and outstanding request counts.
- Stale, damaged, lost, quarantine and service-life inspection flags.

Viewers can read/export their permitted reports. Report access never grants
manufacturing, supplier warehouse or other-hotel access. The local hotel preview
can generate/export its isolated sample reports without enabling mutations.

## Date and filter meanings

- Dates are inclusive UTC calendar days. The default is the latest 30 days; the
  maximum range is 366 days. Invalid or reversed dates are rejected.
- Inventory, product/location stock counts, attention flags and stock coverage are
  **current snapshots**, irrespective of the selected date range. These reports
  do not reconstruct historical opening/closing stock balances.
- Lifetime wash/use counters belong to currently owned, observed items. They are
  not wash/use counts for the selected month. Inventory counts require a known
  product and an observed position; unobserved encoding-only records are not
  presented as confirmed physical stock.
- Location-event reports use observation timestamps. Initial observations are
  labelled separately from movements between locations.
- Request and shipment lists use their creation dates. Status and receiving
  progress are current as of report generation, even if a later update occurred
  outside the creation-date range.
- Daily received quantities use each item's acceptance timestamp, including items
  dispatched before the range. Partial receipts count accepted EPCs only.
- Facility filtering applies to inventory, location summaries, attention flags
  and location events. It does not guess the historical source warehouse of a
  shipment. Commercial datasets and hotel-wide stock rules remain unfiltered by
  facility, as explained above the filters.
- Customer filtering applies only to company commercial requests and transfers.
  It never reveals the customer's current inventory.
- An item can produce multiple attention flags; a flag count is not a count of
  unique affected items. Retired items are retained for traceability.

## Tables and exports

Choose the report dataset, search within it, sort by a column and select the page
size. **Export CSV** includes all records matching the applied report filters and
table search, not just the visible page. Text is UTF-8, quoted for commas/newlines
and guarded against spreadsheet formula injection. Exports and report responses
use private/no-store cache headers. Snapshot filenames use the generation date;
period filenames use the selected date range.

CSV export is a data export, not an invoice or financial statement. No revenue,
cost or profit is inferred from quantities without corresponding financial data.

## Graphical summaries
Company reports chart hotel dispatch cohorts, their current receipt outcomes, product demand and current request status. Customer internal use and laundry data remain private. Hotel charts show room entry and direct laundry-to-clean events per calendar day, stock replenishment requirements and current linen stages. Entry events can repeat and are not unique consumption, completed usage cycles or retirement counts. No stock exhaustion forecast is inferred from reusable linen movement. Detailed source tables are collapsed by default; Item inventory is an optional current reconciliation list. Zero activity is displayed explicitly, without simulated values.
