CREATE TABLE asset_custody_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  epc text NOT NULL,
  custodian_tenant_id uuid NOT NULL REFERENCES tenants(id),
  facility_id uuid REFERENCES facilities(id),
  shipment_id uuid REFERENCES shipments(id),
  change_type text NOT NULL
    CHECK (change_type IN ('registered', 'shipment_received', 'transfer', 'return', 'correction')),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX asset_custody_current_epc_idx
  ON asset_custody_history (epc)
  WHERE valid_to IS NULL;

CREATE INDEX asset_custody_tenant_time_idx
  ON asset_custody_history (custodian_tenant_id, valid_from DESC);

ALTER TABLE asset_custody_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_asset_custody ON asset_custody_history
  USING (custodian_tenant_id = current_app_tenant())
  WITH CHECK (custodian_tenant_id = current_app_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_custody_history TO globaltex_app;
