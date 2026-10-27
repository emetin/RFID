# Product delivery roadmap

Planning date: 2026-10-21.

## Evidence and scope

This plan is based on the current README, readiness checklist, enterprise roadmap,
production deployment guide, onboarding guide, hotel operations implementation,
and source/test inventory. It is a planning review, not a fresh test execution,
security audit, hardware qualification, or production certification.

Existing foundations include EPC registration, custody and shipment reconciliation,
hotel users and stock requests, stock policies, lifecycle tracking, an offline edge
queue, a desktop reader adapter, PostgreSQL persistence, integration outbox, and
Zoho connector code. Implementation does not imply field acceptance. The older
enterprise roadmap should be reconciled with the readiness checklist so completed
foundations are not planned again as missing features.

## Delivery sequence

Durations are provisional effort windows for a small dedicated team, not committed
dates. Hardware procurement, customer access, and certification can extend them.

| Phase | Suggested window | Main deliverables | Acceptance gate | Lead role |
| --- | --- | --- | --- | --- |
| 1. Product clarity and local reliability | 1-2 weeks | Role-based landing pages; clear Hotel portal and Operations navigation; reliable local start/status/stop instructions; actionable connection and session errors; feature-to-evidence inventory | Hotel user sees only assigned hotels and permitted actions; restart and sign-in work; operator completes a demo without developer assistance | Product + application engineering |
| 2. One complete business journey | 2-3 weeks | Guided hotel setup, catalog validation, opening inventory approval, stock-policy setup, request approval, dispatch, receiving and exception resolution; verify existing behavior before extending it | Repeatable acceptance scenario from product registration to hotel receipt; retries cannot duplicate stock; partial receipt stays open with a visible remaining quantity; all mutations are attributable | Application engineering + hotel operations |
| 3. Hardware and operational pilot | 3-6 weeks, hardware dependent | Qualify selected fixed/handheld readers and industrial writer; wet/dry/folded textile reads; site direction calibration; disconnect/reconnect and offline recovery; tag replacement procedure | At least two weeks of manual/RFID reconciliation; zero lost queued events in tested outages; agreed read and false-movement targets achieved | Hardware integration + pilot hotel |
| 4. Production readiness | 2-4 weeks, can overlap pilot | Deployed PostgreSQL and HTTPS; identity provider/MFA; credential rotation; monitoring; off-host backups and restore drill; load/security checks; rollback and support runbooks | Measured capacity covers agreed workload; restore meets agreed recovery objectives; tenant isolation and authorization checks pass; named incident owner | Platform + application engineering |
| 5. First customer integration and chain rollout | 3-6 weeks, customer dependent | Certify one ERP/Zoho connector; mapping preview and reconciliation; parent-chain hierarchy and delegated access where needed; multi-hotel comparison and staged onboarding | Replayed messages have no duplicate effects; failed deliveries are visible and recoverable; first hotel accepted before expanding rollout | Integration engineering + customer owner |
| 6. Optimization | After stable usage | Occupancy-based PAR planning, purchasing suggestions, loss/cost reports, scheduled notifications, handheld search improvements and fleet management | Each feature has a measurable operational benefit and a reliable input dataset | Product + operations |

## Highest-priority backlog

1. Replace ambiguous portal navigation with explicit English labels such as
   `Hotel portal`, `Hotels & users`, and `Stock requests`; choose the landing page
   from role and authorized scope, with server-side enforcement.
2. Provide a local launcher with readiness polling, logs, and a status/stop command.
   Detect a conflicting port and distinguish process startup from actual HTTP readiness.
3. Maintain an acceptance matrix: implemented, automated-test evidence, hardware
   evidence, customer acceptance, and remaining work. Do not use one completed flag
   for all five dimensions.
4. Walk through one replenishment scenario with an operator, including rejection,
   cancellation, partial delivery, missing/unexpected tags, retry and final closure.
   Extend behavior only where the walkthrough exposes a gap.
5. Make inventory meaning explicit: registered, physically observed, available,
   in transit, quarantined, lost, and stale observations must be distinguishable.
6. Establish an approved opening stock snapshot and variance report so later
   shrinkage and reconciliation use a trustworthy baseline.
7. Define a controlled tag replacement workflow with old/new EPC linkage, retired
   old identity, preserved history, and duplicate prevention.
8. Add external notification delivery with preferences and escalation ownership;
   reuse existing alert deduplication and acknowledgement behavior.
9. Certify the first actual reader/site and first actual customer connector before
   expanding adapter and integration coverage.
10. Improve maintainability incrementally: split dashboard code by workflow,
    centralize API/session handling, and keep SQLite/PostgreSQL business behavior
    aligned. Avoid a framework rewrite without an identified delivery benefit.

## Metrics and release gates

- Inventory: unique EPC reconciliation, missing/unexpected quantities, observation
  freshness, and manual/RFID variance.
- Replenishment: request-to-approval time, approval-to-delivery time, and remaining
  quantity after partial receipts.
- Hardware: unique expected tags detected per controlled passage, false confirmed
  movements, queue recovery, and device reconnect time.
- Operations: cycle-count duration, stockouts, wash-cycle exceptions, and loss rate
  against an approved baseline and reporting period.
- Platform: request latency at agreed concurrent load, ingest backlog, integration
  retry/dead-letter age, availability, and measured backup restore duration.

Candidate pilot targets from the existing pilot plan are at least 99% controlled
passage reads, at most 0.5% false movements, zero data loss during tested outages,
and visible shipment variance within two minutes. Agree measurement conditions
and denominators with the customer before treating these as release commitments.

## Decisions required before committing dates

- Pilot property/country, responsible customer operator, and first product family.
- Actual reader, handheld, writer, and textile tag models and procurement dates.
- Hotel/chain ownership and custody rules, including external laundries and returns.
- Expected assets, reads/day, peak burst, concurrent users, and offline duration.
- First ERP integration, source-of-truth rules, and sandbox/API access.
- Hosting region, identity provider, retention, recovery targets, and support owner.

## First ten working days

1. Days 1-2: confirm pilot scope, reconcile documentation with current behavior,
   and reproduce role-based login and local startup.
2. Days 3-5: improve portal naming, role landing pages, setup guidance and local
   readiness feedback; prepare repeatable demo data without changing real data.
3. Days 6-8: execute the replenishment acceptance matrix and fix demonstrated gaps.
4. Days 9-10: review the complete journey with an operator and finalize the hardware
   pilot protocol, customer dependencies, and the next milestone estimate.

Defer predictive AI, broad PMS coverage, native mobile apps, and billing until
the first hotel's core operation is accepted, unless a contracted requirement
changes the priority.
