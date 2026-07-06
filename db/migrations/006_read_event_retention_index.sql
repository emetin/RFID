CREATE INDEX IF NOT EXISTS read_events_tenant_received_idx
  ON read_events (tenant_id, received_at, event_id);
