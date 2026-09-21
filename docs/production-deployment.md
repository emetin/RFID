# Production deployment

The repository includes a hardened deployment baseline in
`compose.production.yaml`. It runs PostgreSQL without a public database port,
applies migrations before the API starts, checks database readiness and exposes
the API through Caddy with automatic HTTPS and security headers.

## Required external inputs

- a Linux host or managed container platform;
- a DNS record for the production domain;
- strong secrets supplied by a secret manager or protected environment file;
- an off-host backup destination;
- the approved reader credentials and customer tenant list.

Copy `deploy/.env.production.example` to a protected deployment environment file
outside source control, replace every value and run:

```sh
docker compose --env-file /secure/path/rfid-production.env \
  -f compose.production.yaml config --quiet
docker compose --env-file /secure/path/rfid-production.env \
  -f compose.production.yaml up -d --build
```

Verify both liveness and database readiness:

```sh
curl -fsS https://rfid.example.com/health
curl -fsS https://rfid.example.com/ready
```

Production startup is rejected unless PostgreSQL, HTTPS public URL, secure
cookies and sufficiently long device/admin/customer credentials are configured.

## PostgreSQL backup baseline

Run `pg_dump` from the PostgreSQL container on a scheduler controlled by the
hosting platform, encrypt the output and copy it off-host:

```sh
docker compose --env-file /secure/path/rfid-production.env \
  -f compose.production.yaml exec -T postgres \
  pg_dump -U globaltex -d globaltex_rfid -Fc > globaltex-rfid.dump
```

A deployment is not accepted until a backup is restored into an isolated
database and the `/ready` plus inventory smoke checks pass. Managed PostgreSQL
should additionally enable point-in-time recovery.

## Remaining release gates

The template is a secure baseline, not evidence that a specific host is ready.
Before customer traffic, complete vulnerability scanning, load testing,
monitoring/alert routing, restore drill, real reader qualification and customer
ERP acceptance against the deployed environment.
