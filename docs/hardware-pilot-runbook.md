# RFID reader/writer qualification runbook

## Information required when hardware arrives

Record these before writing an adapter:

- manufacturer, exact model and serial number;
- firmware version and regional UHF model;
- host protocol: LLRP, MQTT, HTTP, USB/serial or vendor SDK;
- SDK/download link and license terms;
- reader IP/network mode and authentication method;
- antenna model, cable length, port and physical placement;
- writer model and whether it exposes EPC, TID, PC bits and lock operations;
- textile tag chip/antenna model and wash certification;
- pilot country and permitted UHF frequency plan.

Do not update firmware, lock tags or change regional radio settings until the
device and tag configuration have been recorded.

## Canonical capture

The device adapter must emit one JSON object per observation:

```json
{"eventId":"stable-id","epc":"3034257BF7194E4000000001","observedAt":"2026-07-02T15:00:00.000Z","rssi":-47.2,"antenna":1}
```

Retrying the same observation must preserve `eventId`. EPC must be uppercase
hexadecimal. Save raw adapter output as JSON Lines so the qualification report
can be reproduced.

## Reader acceptance

Prepare the expected EPC set in a copy of
`data/templates/hardware-reader-test.json`, then run:

```powershell
npm run hardware:test-reader -- reader-test.json capture.jsonl reader-report.json
```

The report contains:

- unique expected and observed EPC counts;
- read rate, missing and unexpected EPC lists;
- invalid records and duplicate event IDs;
- minimum observations per tag;
- observations by antenna;
- RSSI minimum, maximum, average, p50 and p95;
- test duration and pass/fail criteria.

Run separate captures for:

1. dry and unfolded textiles;
2. folded stacks at realistic trolley/cart density;
3. wet textiles;
4. receiving portal movement in each direction;
5. laundry-out and laundry-in movement;
6. adjacent-zone leakage and stationary tags near the portal;
7. network outage and Gateway replay;
8. at least ten controlled passes with a manually verified EPC set.

Initial pilot targets are read rate at least 99%, false movement at most 0.5%,
no duplicate event IDs and no data loss after an outage. Site calibration may
raise these targets but must not silently lower them.

## Writer acceptance

For every write attempt, record expected EPC, read-back EPC, write status,
optional expected/read TID and lock state in JSON Lines. Use
`data/templates/hardware-writer-verification.jsonl` as the shape:

```powershell
npm run hardware:test-writer -- writer-verification.jsonl writer-report.json
```

Acceptance requires:

- unique EPC allocation before the write;
- successful write status;
- exact EPC read-back using a separate verification step;
- TID match when the supplier provides an expected TID;
- failed writes quarantined and never shipped;
- lock operation performed only after the written EPC has been verified;
- EPC-to-SKU/lot/order association retained in the platform.

Start with unlocked test tags. Locking is irreversible on many chips and must
not be enabled until the customer's encoding policy is approved.

## Evidence package

Keep the following for every test:

- configuration JSON and raw JSONL capture;
- generated qualification report;
- reader/writer and tag photographs;
- antenna layout and measured distances;
- firmware, power and regional settings;
- manual expected count;
- operator, date, facility and environmental condition;
- defects, retests and final approval.

