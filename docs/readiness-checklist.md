# Readiness checklist

This checklist covers Phase 0 preparation only. It is not a production-readiness
or hotel-chain deployment certificate. The remaining enterprise scope is tracked
in [enterprise-roadmap.md](enterprise-roadmap.md).

## Completed without hardware or final catalog

- [x] Device-neutral RFID read contract
- [x] HMAC-authenticated Gateway-to-cloud transport
- [x] Retry-safe event idempotency
- [x] Product CSV contract and sample
- [x] EPC-to-SKU registration contract and sample
- [x] Receiving and inventory scan-session model
- [x] Unique EPC counting
- [x] Box and pallet equivalent calculation
- [x] Unknown or unregistered tag reporting
- [x] English operations dashboard
- [x] PostgreSQL schema and local container definition
- [x] Tenant row-level security design
- [x] Encoding batch and verification data model
- [x] Device adapter acceptance contract
- [x] Automated unit and end-to-end simulation tests

## Inputs still required

- [ ] Final English product list and packaging rules
- [ ] GS1 Company Prefix/GTIN strategy or supplier pre-encoded EPC file
- [ ] Textile tag datasheet and wash-cycle certification
- [ ] Reader/writer and operational reader make/model
- [ ] First pilot hotel, facilities and read zones
- [ ] Hotel ERP/PMS integration specification
- [ ] Production hosting, identity provider and customer-approved retention period

These pending items are integration inputs, not reasons to change the core inventory model.

## Enterprise platform work still required

- [x] Globally unique EPC enforcement and current tenant custody transfer
- [x] EPC shipment manifest and receiving reconciliation foundation
- [x] Dated asset-custody history and facility-level custody ledger
- [x] Tenant facility, zone and reader provisioning with assignment enforcement
- [x] Allowlisted chain-admin switching across hotel tenants
- [ ] Parent-chain master data and delegated regional administration
- [x] Allowlisted chain-admin multi-hotel inventory and SKU rollup
- [x] Token-based role/scoped administration and persistent mutation audit log
- [x] Persistent password-hashed users, signed portal sessions and hotel assignment UI
- [ ] Enterprise OIDC/SAML identity, MFA and identity lifecycle provisioning
- [x] Baseline confidence-gated movement confirmation and pending review queue
- [x] Operator confirm/dismiss resolution for ambiguous movement evidence
- [x] Deduplicated unknown/missing/unexpected EPC exception cases and operator resolution
- [x] Audited active/quarantined/damaged/lost/retired asset lifecycle
- [ ] Site-calibrated antenna direction, RSSI scoring and operator resolution actions
- [ ] Real fixed-reader and handheld adapters
- [x] Versioned multi-vendor Adapter SDK, registry, config validation and conformance CLI
- [x] Reproducible reader/writer capture qualification CLI and pilot runbook
- [x] Encrypted, durable Edge offline queue with ordered retry
- [x] Tenant-scoped Gateway heartbeat and queue-depth health dashboard
- [x] Tenant operational alert rules, acknowledgement and automatic resolution
- [ ] External email/SMS delivery, remote configuration and signed Gateway fleet updates
- [x] PostgreSQL driver, migration tracking, pool and RLS tenant transaction boundary
- [x] Complete PostgreSQL store adapter and live two-tenant isolation test
- [x] Docker API image, migration job and healthy local PostgreSQL stack
- [x] Tenant-scoped raw-read retention preview and bounded purge
- [ ] Production event-processing infrastructure and managed database deployment
- [x] Generic signed ERP/PMS/WMS webhook outbox with retry and dead-letter handling
- [ ] First customer's field mapping, endpoint certification and reconciliation
- [x] Verified SQLite snapshot, hash manifest and controlled restore runbook
- [ ] Off-host backup scheduler, restore drill, production PITR, SLO and incident ownership
- [ ] Hardware pilot and customer acceptance testing
