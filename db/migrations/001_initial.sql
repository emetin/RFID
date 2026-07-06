CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  facility_type text NOT NULL CHECK (facility_type IN ('factory', 'warehouse', 'hotel', 'laundry')),
  timezone text NOT NULL DEFAULT 'UTC',
  UNIQUE (tenant_id, code)
);

CREATE TABLE zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  code text NOT NULL,
  name text NOT NULL,
  zone_type text NOT NULL,
  UNIQUE (facility_id, code)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sku text NOT NULL,
  name text NOT NULL,
  category text,
  size text,
  color text,
  units_per_box integer NOT NULL CHECK (units_per_box > 0),
  boxes_per_pallet integer NOT NULL CHECK (boxes_per_pallet > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku),
  UNIQUE (tenant_id, id)
);

CREATE TABLE encoding_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL,
  requested_quantity integer NOT NULL CHECK (requested_quantity > 0),
  epc_scheme text NOT NULL,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'encoding', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE rfid_assets (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  epc text NOT NULL UNIQUE CHECK (epc ~ '^[0-9A-F]{8,96}$'),
  product_id uuid NOT NULL,
  encoding_batch_id uuid REFERENCES encoding_batches(id),
  tid text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'damaged', 'lost', 'retired')),
  encoding_status text NOT NULL DEFAULT 'registered'
    CHECK (encoding_status IN ('planned', 'written', 'verified', 'locked', 'failed', 'registered')),
  encoded_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, epc),
  UNIQUE NULLS NOT DISTINCT (tenant_id, tid),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_tenant_id uuid NOT NULL REFERENCES tenants(id),
  destination_facility_id uuid NOT NULL REFERENCES facilities(id),
  reference text,
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'partially_received', 'received')),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);

CREATE TABLE shipment_assets (
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  epc text NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  accepted_at timestamptz,
  PRIMARY KEY (shipment_id, epc)
);

CREATE INDEX shipments_supplier_idx ON shipments (supplier_tenant_id, created_at DESC);
CREATE INDEX shipments_customer_idx ON shipments (customer_tenant_id, created_at DESC);

CREATE TABLE readers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  zone_id uuid NOT NULL REFERENCES zones(id),
  code text NOT NULL,
  model text,
  protocol text,
  last_seen_at timestamptz,
  UNIQUE (tenant_id, code)
);

CREATE TABLE scan_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  zone_id uuid NOT NULL REFERENCES zones(id),
  session_type text NOT NULL
    CHECK (session_type IN ('receiving', 'inventory', 'transfer', 'laundry_out', 'laundry_in')),
  reference text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE read_events (
  received_at timestamptz NOT NULL DEFAULT now(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id uuid NOT NULL,
  epc text NOT NULL CHECK (epc ~ '^[0-9A-F]{8,96}$'),
  reader_id uuid NOT NULL REFERENCES readers(id),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  zone_id uuid NOT NULL REFERENCES zones(id),
  session_id uuid REFERENCES scan_sessions(id),
  observed_at timestamptz NOT NULL,
  rssi real,
  antenna integer,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE inventory_positions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  epc text NOT NULL,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  zone_id uuid NOT NULL REFERENCES zones(id),
  reader_id uuid NOT NULL REFERENCES readers(id),
  session_id uuid REFERENCES scan_sessions(id),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  read_count bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, epc)
);

CREATE TABLE movement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  epc text NOT NULL,
  from_facility_id uuid REFERENCES facilities(id),
  from_zone_id uuid REFERENCES zones(id),
  to_facility_id uuid NOT NULL REFERENCES facilities(id),
  to_zone_id uuid NOT NULL REFERENCES zones(id),
  reader_id uuid NOT NULL REFERENCES readers(id),
  confidence numeric(5,4),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pending_movements (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  epc text NOT NULL,
  from_facility_id uuid NOT NULL REFERENCES facilities(id),
  from_zone_id uuid NOT NULL REFERENCES zones(id),
  to_facility_id uuid NOT NULL REFERENCES facilities(id),
  to_zone_id uuid NOT NULL REFERENCES zones(id),
  reader_id uuid NOT NULL REFERENCES readers(id),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  observations integer NOT NULL CHECK (observations > 0),
  reason text NOT NULL,
  PRIMARY KEY (tenant_id, epc)
);

CREATE TABLE gateway_health (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  reader_id uuid NOT NULL REFERENCES readers(id),
  adapter text NOT NULL,
  gateway_version text NOT NULL,
  reader_connected boolean NOT NULL,
  queue_depth integer NOT NULL CHECK (queue_depth >= 0),
  last_read_at timestamptz,
  last_error text,
  heartbeat_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reader_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL,
  aggregate_id text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE TABLE operational_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  dedupe_key text NOT NULL,
  alert_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved')),
  entity_type text NOT NULL,
  entity_id text,
  title text NOT NULL,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by text,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX read_events_epc_time_idx ON read_events (tenant_id, epc, observed_at DESC);
CREATE INDEX read_events_session_idx ON read_events (tenant_id, session_id);
CREATE INDEX inventory_positions_location_idx ON inventory_positions (tenant_id, facility_id, zone_id);
CREATE INDEX movement_events_epc_time_idx ON movement_events (tenant_id, epc, observed_at DESC);
CREATE INDEX pending_movements_target_idx ON pending_movements (tenant_id, to_facility_id, to_zone_id);
CREATE INDEX gateway_health_received_idx ON gateway_health (tenant_id, received_at DESC);
CREATE INDEX audit_events_tenant_time_idx ON audit_events (tenant_id, created_at DESC);
CREATE INDEX integration_outbox_delivery_idx ON integration_outbox (tenant_id, status, next_attempt_at, created_at);
CREATE INDEX operational_alerts_status_idx ON operational_alerts (tenant_id, status, severity, last_seen_at DESC);

-- The API must set this inside every transaction:
-- SET LOCAL app.tenant_id = '<tenant uuid>';
CREATE FUNCTION current_app_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE encoding_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfid_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE readers ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE read_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE movement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_facilities ON facilities USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_zones ON zones USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_products ON products USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_encoding_batches ON encoding_batches USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_assets ON rfid_assets USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_shipments ON shipments
  USING (
    supplier_tenant_id = current_app_tenant()
    OR customer_tenant_id = current_app_tenant()
  );
CREATE POLICY tenant_isolation_shipment_assets ON shipment_assets
  USING (
    EXISTS (
      SELECT 1 FROM shipments
      WHERE shipments.id = shipment_assets.shipment_id
        AND (
          shipments.supplier_tenant_id = current_app_tenant()
          OR shipments.customer_tenant_id = current_app_tenant()
        )
    )
  );
CREATE POLICY tenant_isolation_readers ON readers USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_sessions ON scan_sessions USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_reads ON read_events USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_positions ON inventory_positions USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_movements ON movement_events USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_pending_movements ON pending_movements USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_gateway_health ON gateway_health USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_audit_events ON audit_events USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_integration_outbox ON integration_outbox USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());
CREATE POLICY tenant_isolation_operational_alerts ON operational_alerts USING (tenant_id = current_app_tenant()) WITH CHECK (tenant_id = current_app_tenant());

-- Runtime queries assume this non-owner role so table-owner RLS bypass cannot
-- silently defeat tenant isolation. Migration/system operations retain the
-- owner connection and must be kept out of request-level code.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'globaltex_app') THEN
    CREATE ROLE globaltex_app NOLOGIN;
  END IF;
  EXECUTE format('GRANT globaltex_app TO %I', current_user);
END
$$;

GRANT USAGE ON SCHEMA public TO globaltex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO globaltex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO globaltex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO globaltex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO globaltex_app;
