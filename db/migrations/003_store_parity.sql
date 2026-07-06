ALTER TABLE facilities
  ADD COLUMN active boolean NOT NULL DEFAULT true;

ALTER TABLE zones
  ADD COLUMN active boolean NOT NULL DEFAULT true;

ALTER TABLE readers
  ADD COLUMN name text NOT NULL DEFAULT '',
  ADD COLUMN adapter text NOT NULL DEFAULT 'unknown',
  ADD COLUMN active boolean NOT NULL DEFAULT true;

ALTER TABLE inventory_positions
  ADD COLUMN last_rssi real,
  ADD COLUMN last_antenna integer;

ALTER TABLE shipments
  ADD COLUMN external_id text;

UPDATE shipments SET external_id = id::text WHERE external_id IS NULL;

ALTER TABLE shipments
  ALTER COLUMN external_id SET NOT NULL,
  ADD CONSTRAINT shipments_external_id_key UNIQUE (external_id);

CREATE TABLE session_epcs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL REFERENCES scan_sessions(id),
  epc text NOT NULL,
  PRIMARY KEY (tenant_id, session_id, epc)
);

ALTER TABLE session_epcs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_session_epcs ON session_epcs
  USING (tenant_id = current_app_tenant())
  WITH CHECK (tenant_id = current_app_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON session_epcs TO globaltex_app;
