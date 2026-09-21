CREATE SEQUENCE globaltex_epc_serial_seq AS bigint START WITH 1;

ALTER TABLE encoding_batches ADD COLUMN started_at timestamptz;

CREATE TABLE encoding_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES encoding_batches(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sequence_number integer NOT NULL,
  epc text NOT NULL UNIQUE CHECK (epc ~ '^[0-9A-F]{24}$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'verified', 'failed')),
  station_id text,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  previous_epc text,
  tid text,
  error_code text,
  error_message text,
  written_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, sequence_number)
);

CREATE INDEX encoding_jobs_claim_idx
  ON encoding_jobs (tenant_id, status, lease_until, batch_id, sequence_number);

ALTER TABLE encoding_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_encoding_jobs ON encoding_jobs
  USING (tenant_id = current_app_tenant())
  WITH CHECK (tenant_id = current_app_tenant());

GRANT SELECT, INSERT, UPDATE ON encoding_jobs TO globaltex_app;
GRANT USAGE, SELECT ON SEQUENCE globaltex_epc_serial_seq TO globaltex_app;
