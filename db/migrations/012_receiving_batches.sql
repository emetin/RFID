CREATE TABLE receiving_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  expected_quantity integer NOT NULL CHECK (expected_quantity > 0),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  zone_id uuid NOT NULL REFERENCES zones(id),
  reference text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by text,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE receiving_batch_tags (
  batch_id uuid NOT NULL REFERENCES receiving_batches(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  epc text NOT NULL CHECK (epc ~ '^[0-9A-F]{8,96}$'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  read_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (batch_id, epc)
);

CREATE INDEX receiving_batches_tenant_created_idx
  ON receiving_batches (tenant_id, created_at DESC);

ALTER TABLE receiving_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE receiving_batch_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_receiving_batches ON receiving_batches
  USING (tenant_id = current_app_tenant())
  WITH CHECK (tenant_id = current_app_tenant());

CREATE POLICY tenant_isolation_receiving_batch_tags ON receiving_batch_tags
  USING (tenant_id = current_app_tenant())
  WITH CHECK (tenant_id = current_app_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON receiving_batches TO globaltex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON receiving_batch_tags TO globaltex_app;
