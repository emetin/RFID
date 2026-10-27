ALTER TABLE rfid_assets
  ADD COLUMN wash_count integer NOT NULL DEFAULT 0 CHECK (wash_count >= 0),
  ADD COLUMN inspection_required boolean NOT NULL DEFAULT false,
  ADD COLUMN last_clean_return_at timestamptz;

CREATE INDEX rfid_assets_not_seen_idx
  ON rfid_assets (tenant_id, status, created_at);

