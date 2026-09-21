CREATE TABLE customer_api_idempotency (
  tenant_slug text NOT NULL,
  client_id text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  idempotency_key text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_slug, client_id, method, path, idempotency_key)
);

CREATE TABLE customer_api_rate_limits (
  client_id text NOT NULL,
  window_start bigint NOT NULL,
  request_count integer NOT NULL,
  PRIMARY KEY (client_id, window_start)
);

CREATE INDEX customer_api_idempotency_created_idx
  ON customer_api_idempotency (created_at);

REVOKE ALL ON customer_api_idempotency, customer_api_rate_limits FROM globaltex_app;
