CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'operator', 'hotel_admin', 'chain_admin')),
  default_tenant_slug text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_user_tenants (
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  tenant_slug text NOT NULL,
  PRIMARY KEY (user_id, tenant_slug)
);

CREATE INDEX admin_user_tenants_slug_idx
  ON admin_user_tenants (tenant_slug, user_id);

REVOKE ALL ON admin_users, admin_user_tenants FROM globaltex_app;
