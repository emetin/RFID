# PostgreSQL production preparation

## Current status

The repository includes the official `pg` driver, connection pooling,
transactional migration tracking, health checks, tenant-scoped transactions and
a complete PostgreSQL implementation of the active API store contract.
Provisioning, inventory ingestion, movement confirmation, shipment custody,
health, audit, outbox and alert flows have live PostgreSQL tests.

## Local PostgreSQL

The local Windows development environment uses Docker Desktop with the WSL2
backend:

```powershell
$env:POSTGRES_PASSWORD="replace-local-password"
docker compose up -d postgres
$env:DATABASE_URL="postgresql://globaltex:replace-local-password@127.0.0.1:5432/globaltex_rfid"
npm run db:migrate
npm run db:check
npm run db:test-rls
$env:TEST_POSTGRES_URL=$env:DATABASE_URL
npm run test:postgres
```

The compose service no longer auto-runs the SQL file. `db:migrate` records each
filename in `schema_migrations`, so migrations are applied exactly once.

The complete local stack can be started with:

```powershell
docker compose up -d --build api
```

The PostgreSQL-backed portal is then available on
`http://127.0.0.1:8081/dashboard`. Port 8081 intentionally avoids the local
SQLite API on port 8080.

## Tenant transaction boundary

Every tenant request must run through `tenantTransaction(tenantId, operation)`.
It performs, in one database transaction:

1. `BEGIN`
2. `SET LOCAL ROLE globaltex_app`
3. `set_config('app.tenant_id', tenantId, true)`
4. application queries
5. `COMMIT` or `ROLLBACK`

The non-owner `globaltex_app` role prevents table-owner RLS bypass. Cross-tenant
custody transfers and tenant provisioning must use a separately reviewed system
operation rather than a request-level tenant transaction.

## Production requirements

- managed PostgreSQL with TLS required;
- separate migration and runtime credentials;
- runtime credential permitted to assume only `globaltex_app`;
- connection pool sized against database limits;
- automated backups and point-in-time recovery;
- migration execution as a deployment job before API rollout;
- live RLS isolation tests using at least two tenants;
- rolling deployment and rollback runbook.
