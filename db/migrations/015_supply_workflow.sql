ALTER TABLE rfid_assets
  ADD COLUMN use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  ADD COLUMN cycle_phase text NOT NULL DEFAULT 'clean';
