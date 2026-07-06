ALTER TABLE read_events
  ALTER COLUMN event_id TYPE text USING event_id::text;
