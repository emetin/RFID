ALTER TABLE rfid_assets
  DROP CONSTRAINT rfid_assets_status_check;

ALTER TABLE rfid_assets
  ADD CONSTRAINT rfid_assets_status_check
  CHECK (status IN ('active', 'quarantined', 'damaged', 'lost', 'retired'));

CREATE TABLE asset_lifecycle_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  epc text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL,
  actor_id text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO asset_lifecycle_history (
  tenant_id, epc, from_status, to_status, reason, actor_id, changed_at
)
SELECT tenant_id, epc, NULL, status, 'registration', 'migration_backfill', created_at
FROM rfid_assets;

CREATE INDEX asset_lifecycle_tenant_epc_time_idx
  ON asset_lifecycle_history (tenant_id, epc, changed_at DESC);

ALTER TABLE asset_lifecycle_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_asset_lifecycle ON asset_lifecycle_history
  USING (tenant_id = current_app_tenant())
  WITH CHECK (tenant_id = current_app_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_lifecycle_history TO globaltex_app;
