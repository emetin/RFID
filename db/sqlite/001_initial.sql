PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS products (
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  units_per_box INTEGER NOT NULL CHECK (units_per_box > 0),
  boxes_per_pallet INTEGER NOT NULL CHECK (boxes_per_pallet > 0),
  size TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS epc_allocator (
  namespace TEXT PRIMARY KEY,
  next_serial TEXT NOT NULL
);
INSERT OR IGNORE INTO epc_allocator (namespace, next_serial) VALUES ('GTX96', '1');

CREATE TABLE IF NOT EXISTS encoding_batches (
  batch_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
  epc_scheme TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','encoding','completed','cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (tenant_id, sku) REFERENCES products (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS encoding_jobs (
  job_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  epc TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued','leased','verified','failed')),
  station_id TEXT,
  lease_token TEXT,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  previous_epc TEXT,
  tid TEXT,
  error_code TEXT,
  error_message TEXT,
  written_at TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (batch_id, sequence_number),
  FOREIGN KEY (batch_id) REFERENCES encoding_batches (batch_id)
);
CREATE INDEX IF NOT EXISTS encoding_jobs_claim_idx
  ON encoding_jobs (tenant_id, status, lease_until, batch_id, sequence_number);

CREATE TABLE IF NOT EXISTS admin_users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  default_tenant_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_user_tenants (
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (user_id, tenant_id),
  FOREIGN KEY (user_id) REFERENCES admin_users (user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rfid_assets (
  tenant_id TEXT NOT NULL,
  epc TEXT NOT NULL,
  sku TEXT NOT NULL,
  tid TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  encoded_at TEXT,
  PRIMARY KEY (tenant_id, epc),
  FOREIGN KEY (tenant_id, sku) REFERENCES products (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS asset_lifecycle_history (
  history_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  epc TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

INSERT OR IGNORE INTO asset_lifecycle_history (
  history_id, tenant_id, epc, from_status, to_status, reason, actor_id, changed_at
)
SELECT tenant_id || ':' || epc || ':registration',
       tenant_id, epc, NULL, status, 'registration', 'migration_backfill',
       COALESCE(encoded_at, '1970-01-01T00:00:00.000Z')
FROM rfid_assets AS asset
WHERE NOT EXISTS (
  SELECT 1 FROM asset_lifecycle_history AS history
  WHERE history.tenant_id = asset.tenant_id AND history.epc = asset.epc
);

CREATE TABLE IF NOT EXISTS asset_custody_history (
  custody_id TEXT PRIMARY KEY,
  epc TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  facility_id TEXT,
  shipment_id TEXT,
  change_type TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_custody_current_epc_idx
  ON asset_custody_history (epc)
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS asset_custody_tenant_time_idx
  ON asset_custody_history (tenant_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS asset_lifecycle_tenant_epc_time_idx
  ON asset_lifecycle_history (tenant_id, epc, changed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS rfid_assets_global_epc_idx
  ON rfid_assets (epc);

CREATE TABLE IF NOT EXISTS shipments (
  shipment_id TEXT PRIMARY KEY,
  supplier_tenant_id TEXT NOT NULL,
  customer_tenant_id TEXT NOT NULL,
  destination_facility_id TEXT NOT NULL,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE TABLE IF NOT EXISTS shipment_assets (
  shipment_id TEXT NOT NULL,
  epc TEXT NOT NULL,
  sku TEXT NOT NULL,
  accepted_at TEXT,
  PRIMARY KEY (shipment_id, epc),
  FOREIGN KEY (shipment_id) REFERENCES shipments (shipment_id)
);

CREATE TABLE IF NOT EXISTS facilities (
  tenant_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  name TEXT NOT NULL,
  facility_type TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, facility_id)
);

CREATE TABLE IF NOT EXISTS zones (
  tenant_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  name TEXT NOT NULL,
  zone_type TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, zone_id),
  FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, facility_id)
);

CREATE TABLE IF NOT EXISTS readers (
  tenant_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, reader_id),
  FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, facility_id),
  FOREIGN KEY (tenant_id, zone_id)
    REFERENCES zones (tenant_id, zone_id)
);

CREATE INDEX IF NOT EXISTS shipments_supplier_idx
  ON shipments (supplier_tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shipments_customer_idx
  ON shipments (customer_tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scan_sessions (
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  type TEXT NOT NULL,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, session_id)
);

CREATE TABLE IF NOT EXISTS session_epcs (
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  epc TEXT NOT NULL,
  PRIMARY KEY (tenant_id, session_id, epc),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES scan_sessions (tenant_id, session_id)
);

CREATE TABLE IF NOT EXISTS receiving_batches (
  batch_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  expected_quantity INTEGER NOT NULL CHECK (expected_quantity > 0),
  facility_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  FOREIGN KEY (tenant_id, sku) REFERENCES products (tenant_id, sku),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities (tenant_id, facility_id),
  FOREIGN KEY (tenant_id, zone_id) REFERENCES zones (tenant_id, zone_id)
);

CREATE TABLE IF NOT EXISTS receiving_batch_tags (
  batch_id TEXT NOT NULL,
  epc TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  read_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (batch_id, epc),
  FOREIGN KEY (batch_id) REFERENCES receiving_batches (batch_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS receiving_batches_tenant_created_idx
  ON receiving_batches (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS read_events (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  epc TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  session_id TEXT,
  observed_at TEXT NOT NULL,
  rssi REAL,
  antenna INTEGER,
  received_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE IF NOT EXISTS inventory_positions (
  tenant_id TEXT NOT NULL,
  epc TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  session_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  read_count INTEGER NOT NULL DEFAULT 1,
  last_rssi REAL,
  last_antenna INTEGER,
  PRIMARY KEY (tenant_id, epc)
);

CREATE TABLE IF NOT EXISTS movement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  epc TEXT NOT NULL,
  from_facility_id TEXT,
  from_zone_id TEXT,
  to_facility_id TEXT NOT NULL,
  to_zone_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_movements (
  tenant_id TEXT NOT NULL,
  epc TEXT NOT NULL,
  from_facility_id TEXT NOT NULL,
  from_zone_id TEXT NOT NULL,
  to_facility_id TEXT NOT NULL,
  to_zone_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  observations INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (tenant_id, epc)
);

CREATE TABLE IF NOT EXISTS gateway_health (
  tenant_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  gateway_version TEXT NOT NULL,
  reader_connected INTEGER NOT NULL,
  queue_depth INTEGER NOT NULL,
  last_read_at TEXT,
  last_error TEXT,
  heartbeat_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, reader_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_api_idempotency (
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, method, path, idempotency_key)
);

CREATE TABLE IF NOT EXISTS customer_api_rate_limits (
  client_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (client_id, window_start)
);

CREATE TABLE IF NOT EXISTS integration_outbox (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS operational_alerts (
  alert_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  resolved_at TEXT,
  UNIQUE (tenant_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS exception_cases (
  case_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  exception_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  epc TEXT,
  shipment_id TEXT,
  session_id TEXT,
  details_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolution TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS read_events_epc_time_idx
  ON read_events (tenant_id, epc, observed_at DESC);
CREATE INDEX IF NOT EXISTS read_events_session_idx
  ON read_events (tenant_id, session_id);
CREATE INDEX IF NOT EXISTS read_events_tenant_received_idx
  ON read_events (tenant_id, received_at, event_id);
CREATE INDEX IF NOT EXISTS inventory_positions_location_idx
  ON inventory_positions (tenant_id, facility_id, zone_id);
CREATE INDEX IF NOT EXISTS movement_events_epc_time_idx
  ON movement_events (tenant_id, epc, observed_at DESC);
CREATE INDEX IF NOT EXISTS pending_movements_target_idx
  ON pending_movements (tenant_id, to_facility_id, to_zone_id);
CREATE INDEX IF NOT EXISTS gateway_health_received_idx
  ON gateway_health (tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx
  ON audit_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS integration_outbox_delivery_idx
  ON integration_outbox (tenant_id, status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS operational_alerts_status_idx
  ON operational_alerts (tenant_id, status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS exception_cases_status_idx
  ON exception_cases (tenant_id, status, severity, last_seen_at DESC);
