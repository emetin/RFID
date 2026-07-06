# Backup and disaster recovery

## Creating a verified backup

The SQLite pilot uses `VACUUM INTO` to create a transactionally consistent
snapshot while the source database is open:

```powershell
npm run backup:create
```

Configuration:

- `SQLITE_PATH`: source database, default `data/runtime/rfid.db`
- `BACKUP_DIR`: destination directory, default `data/backups`

Every backup has a JSON manifest containing its creation time, byte size,
SHA-256 digest, integrity result and schema table count. Backups and manifests
must be copied to encrypted storage outside the Gateway/API computer.

## Verifying a retained backup

```powershell
npm run backup:verify -- data/backups/rfid-TIMESTAMP.db data/backups/rfid-TIMESTAMP.db.manifest.json
```

Verification fails if SQLite integrity is not `ok` or the file digest differs
from the manifest. A backup is not considered successful until this check
passes in the destination storage.

## Controlled restore procedure

Restore is intentionally not an automatic overwrite operation.

1. Declare a maintenance window and stop API, Gateway and integration workers.
2. Preserve the current database and its WAL/SHM files as incident evidence.
3. Verify the selected backup against its manifest.
4. Copy the backup to a new restore path; do not overwrite the original.
5. Start one API instance with `SQLITE_PATH` pointing to the restore path.
6. Verify `/health`, admin login, tenant inventory, shipment state, audit events
   and integration outbox counts.
7. Run a controlled simulated RFID read and confirm idempotency.
8. Approve the restored path for service, or return to the preserved original.
9. Record the incident, restored backup ID, data-loss window and approver.

## Production policy

The customer must set the final RPO and RTO. Before a production rollout:

- schedule automated backups at an interval that meets the RPO;
- copy them to encrypted, access-controlled off-host/object storage;
- retain multiple daily and monthly recovery points;
- alert on missing or failed backup verification;
- perform and document periodic restore drills;
- use PostgreSQL point-in-time recovery for the multi-hotel production tier.

