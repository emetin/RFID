CREATE TABLE exception_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  dedupe_key text NOT NULL,
  exception_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  epc text,
  shipment_id text,
  session_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolution text,
  resolved_by text,
  resolved_at timestamptz,
  UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX exception_cases_status_idx
  ON exception_cases (tenant_id, status, severity, last_seen_at DESC);

ALTER TABLE exception_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_exception_cases ON exception_cases
  USING (tenant_id = current_app_tenant())
  WITH CHECK (tenant_id = current_app_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON exception_cases TO globaltex_app;
