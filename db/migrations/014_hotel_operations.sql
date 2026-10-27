CREATE TABLE hotel_operations (
  tenant_slug text PRIMARY KEY,
  document jsonb NOT NULL DEFAULT '{"hotels":[],"policies":[],"requests":[]}'::jsonb
);
ALTER TABLE hotel_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY hotel_operations_isolation ON hotel_operations
  USING (tenant_slug = current_setting('app.hotel_slug', true))
  WITH CHECK (tenant_slug = current_setting('app.hotel_slug', true));
GRANT SELECT, INSERT, UPDATE ON hotel_operations TO globaltex_app;
