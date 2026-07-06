ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_tenants ON tenants
  USING (id = current_app_tenant())
  WITH CHECK (id = current_app_tenant());
