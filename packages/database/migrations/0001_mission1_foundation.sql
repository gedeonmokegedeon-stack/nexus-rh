-- ============================================================================
-- NEXUS RH — Migration 0001 : Fondations Mission 1
-- Multi-Tenancy PostgreSQL (FORCE RLS), Organisation Multi-Sites RDC,
-- Identité/MFA/Sessions, RBAC + Périmètre Site, Gouvernance Biométrique
-- (DEVICE_ONLY par défaut), Outbox Transactionnel & Audit Immuable SHA-256.
-- ============================================================================

-- 1. Rôle applicatif sans privilège SUPERUSER ni BYPASSRLS (garantie RLS stricte)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
    CREATE ROLE nexus_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO nexus_app;

-- 2. Domaine D1 : Plans d'abonnement SaaS & Entreprises clientes (Tenants)
CREATE TABLE subscription_plans (
  id UUID PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  max_active_employees INTEGER NOT NULL CHECK (max_active_employees > 0),
  max_sites INTEGER NOT NULL CHECK (max_sites > 0),
  max_biometric_devices INTEGER NOT NULL CHECK (max_biometric_devices >= 0),
  storage_quota_bytes BIGINT NOT NULL CHECK (storage_quota_bytes > 0),
  enabled_modules JSONB NOT NULL DEFAULT '[]'::jsonb,
  base_price NUMERIC(18, 4) NULL,
  price_per_employee NUMERIC(18, 4) NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency IN ('CDF', 'USD', 'EUR')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  slug VARCHAR(63) NOT NULL UNIQUE,
  legal_name VARCHAR(255) NOT NULL,
  trade_name VARCHAR(255) NULL,
  legal_form VARCHAR(50) NOT NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'CD',
  sector_code VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
  rccm VARCHAR(100) NULL,
  id_nat VARCHAR(100) NULL,
  tax_id_dgi VARCHAR(100) NULL,
  cnss_employer_number VARCHAR(100) NULL,
  inpp_employer_number VARCHAR(100) NULL,
  onem_employer_number VARCHAR(100) NULL,
  default_currency CHAR(3) NOT NULL DEFAULT 'CDF' CHECK (default_currency IN ('CDF', 'USD', 'EUR')),
  matricule_pattern VARCHAR(120) NOT NULL DEFAULT '{SITE}-{YYYY}-{SEQ:5}',
  encryption_key_ref VARCHAR(255) NOT NULL,
  -- Décision propriétaire n° 6 : stockage biométrique local sur terminal par défaut strict
  biometric_storage_policy VARCHAR(24) NOT NULL DEFAULT 'DEVICE_ONLY'
    CHECK (biometric_storage_policy IN ('DEVICE_ONLY', 'ENCRYPTED_CENTRAL_SYNC')),
  central_template_storage_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  biometric_legal_authorization_ref VARCHAR(160) NULL,
  biometric_policy_approved_by UUID NULL,
  biometric_policy_approved_at TIMESTAMPTZ NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('TRIAL', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED')),
  is_demo_tenant BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Triple verrou SQL empêchant tout stockage central de gabarits biométriques sans autorisation
  CONSTRAINT chk_tenants_biometric_policy_lock CHECK (
    (
      biometric_storage_policy = 'DEVICE_ONLY'
      AND central_template_storage_enabled = FALSE
    )
    OR (
      biometric_storage_policy = 'ENCRYPTED_CENTRAL_SYNC'
      AND biometric_legal_authorization_ref IS NOT NULL
      AND length(btrim(biometric_legal_authorization_ref)) >= 5
      AND biometric_policy_approved_by IS NOT NULL
      AND biometric_policy_approved_at IS NOT NULL
    )
  )
);

CREATE TABLE tenant_subscriptions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  status VARCHAR(24) NOT NULL DEFAULT 'TRIAL'
    CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED')),
  billing_cycle VARCHAR(16) NOT NULL DEFAULT 'MONTHLY'
    CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ NULL,
  custom_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Établissements / Sites multi-provinces & multi-fuseaux (Africa/Kinshasa, Africa/Lubumbashi)
CREATE TABLE sites (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(200) NOT NULL,
  site_type VARCHAR(40) NOT NULL DEFAULT 'BRANCH',
  province VARCHAR(80) NOT NULL,
  city VARCHAR(100) NOT NULL,
  commune VARCHAR(100) NULL,
  address_line TEXT NULL,
  timezone VARCHAR(64) NOT NULL,
  latitude NUMERIC(9, 6) NULL CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  longitude NUMERIC(9, 6) NULL CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
  geofence_radius_meters INTEGER NULL CHECK (geofence_radius_meters IS NULL OR (geofence_radius_meters >= 20 AND geofence_radius_meters <= 50000)),
  transport_zone_code VARCHAR(40) NULL,
  is_headquarters BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sites_tenant_code UNIQUE (tenant_id, code),
  CONSTRAINT uq_sites_id_tenant UNIQUE (id, tenant_id)
);

CREATE TABLE departments (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id UUID NULL,
  parent_department_id UUID NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_departments_tenant_code UNIQUE (tenant_id, code),
  CONSTRAINT uq_departments_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_departments_site FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_departments_parent FOREIGN KEY (parent_department_id, tenant_id) REFERENCES departments(id, tenant_id) ON DELETE RESTRICT
);

-- 4. Domaine D2 : Identité, MFA TOTP, Sessions rotatives, RBAC & Périmètre Site
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE CHECK (email = lower(email)),
  phone VARCHAR(32) NULL,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  is_platform_superadmin BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_count SMALLINT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ NULL,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LOCKED', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tenants
  ADD CONSTRAINT fk_tenants_biometric_approver
  FOREIGN KEY (biometric_policy_approved_by) REFERENCES users(id) ON DELETE RESTRICT;

CREATE TABLE mfa_factors (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  factor_type VARCHAR(24) NOT NULL CHECK (factor_type IN ('TOTP', 'RECOVERY_CODES')),
  encrypted_payload JSONB NOT NULL,
  last_used_step BIGINT NULL,
  verified_at TIMESTAMPTZ NULL,
  last_used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mfa_user_type UNIQUE (user_id, factor_type)
);

CREATE TABLE user_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_tenant_id UUID NULL REFERENCES tenants(id) ON DELETE SET NULL,
  refresh_token_hash CHAR(64) NOT NULL UNIQUE,
  token_family_id UUID NOT NULL,
  mfa_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoke_reason VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (
  id UUID PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  module VARCHAR(40) NOT NULL,
  description TEXT NOT NULL,
  is_sensitive BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE roles (
  id UUID PRIMARY KEY,
  tenant_id UUID NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code VARCHAR(48) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_roles_system_scope CHECK (
    (is_system = TRUE AND tenant_id IS NULL)
    OR (is_system = FALSE AND tenant_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_roles_system_code ON roles(code) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX uq_roles_tenant_code ON roles(tenant_id, code) WHERE tenant_id IS NOT NULL;

CREATE TABLE role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE tenant_memberships (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  scope_type VARCHAR(24) NOT NULL DEFAULT 'ALL_SITES'
    CHECK (scope_type IN ('ALL_SITES', 'SELECTED_SITES', 'OWN_DEPARTMENT', 'SELF_ONLY')),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_membership_tenant_user_role UNIQUE (tenant_id, user_id, role_id),
  CONSTRAINT uq_membership_id_tenant UNIQUE (id, tenant_id)
);

CREATE TABLE membership_site_scopes (
  membership_id UUID NOT NULL,
  site_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  PRIMARY KEY (membership_id, site_id),
  CONSTRAINT fk_scope_membership FOREIGN KEY (membership_id, tenant_id)
    REFERENCES tenant_memberships(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_scope_site FOREIGN KEY (site_id, tenant_id)
    REFERENCES sites(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL,
  key_prefix VARCHAR(16) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_per_min BETWEEN 1 AND 10000),
  expires_at TIMESTAMPTZ NULL,
  last_used_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Domaine D7 : Outbox transactionnel (RabbitMQ) & Journal d'audit immuable SHA-256
CREATE TABLE outbox_events (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  exchange VARCHAR(80) NOT NULL,
  routing_key VARCHAR(120) NOT NULL,
  payload JSONB NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED', 'DLQ')),
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  seq_no BIGSERIAL NOT NULL UNIQUE,
  tenant_id UUID NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  chain_scope VARCHAR(64) NOT NULL, -- UUID du tenant ou 'PLATFORM'
  actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'API_KEY', 'DEVICE', 'SUPERADMIN')),
  actor_id UUID NULL,
  actor_email VARCHAR(255) NULL,
  actor_role VARCHAR(64) NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  request_id VARCHAR(64) NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(128) NULL,
  site_id UUID NULL,
  reason TEXT NULL,
  before_state JSONB NULL,
  after_state JSONB NULL,
  prev_hash CHAR(64) NOT NULL,
  entry_hash CHAR(64) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_audit_chain_scope CHECK (
    (tenant_id IS NULL AND chain_scope = 'PLATFORM')
    OR (tenant_id IS NOT NULL AND chain_scope = tenant_id::text)
  )
);

-- 6. Déclencheur d'immuabilité stricte sur audit_logs (append-only)
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUABILITÉ VIOLÉE : les entrées du journal audit_logs ne peuvent être ni modifiées ni supprimées (%).', TG_OP
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();

-- 7. Index stratégiques composites (tenant_id toujours en tête)
CREATE INDEX idx_sites_tenant_status ON sites(tenant_id, status);
CREATE INDEX idx_departments_tenant_site ON departments(tenant_id, site_id);
CREATE INDEX idx_memberships_tenant_user ON tenant_memberships(tenant_id, user_id, status);
CREATE INDEX idx_memberships_user_status ON tenant_memberships(user_id, status);
CREATE INDEX idx_sessions_user_active ON user_sessions(user_id, revoked_at, expires_at);
CREATE INDEX idx_sessions_family ON user_sessions(token_family_id);
CREATE INDEX idx_outbox_pending ON outbox_events(tenant_id, status, next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX idx_audit_chain_scope_seq ON audit_logs(chain_scope, seq_no ASC);
CREATE INDEX idx_audit_tenant_occurred ON audit_logs(tenant_id, occurred_at DESC);

-- 8. Activation stricte de PostgreSQL Row-Level Security (FORCE RLS)
-- Toutes les tables multi-tenant exigent current_setting('app.current_tenant_id', true)::uuid

ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_subscriptions ON tenant_subscriptions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_sites ON sites
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_departments ON departments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_roles_select ON roles
  FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );
CREATE POLICY tenant_isolation_roles_write ON roles
  FOR ALL
  USING (
    (current_setting('app.platform_context', true) = 'true' AND tenant_id IS NULL)
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    (current_setting('app.platform_context', true) = 'true' AND tenant_id IS NULL)
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_role_permissions_select ON role_permissions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND (
          r.tenant_id IS NULL
          OR r.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        )
    )
  );
CREATE POLICY tenant_isolation_role_permissions_write ON role_permissions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND (
          (current_setting('app.platform_context', true) = 'true' AND r.tenant_id IS NULL)
          OR r.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND (
          (current_setting('app.platform_context', true) = 'true' AND r.tenant_id IS NULL)
          OR r.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        )
    )
  );

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_memberships ON tenant_memberships
  USING (
    current_setting('app.platform_context', true) = 'true'
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.platform_context', true) = 'true'
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

ALTER TABLE membership_site_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_site_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_site_scopes ON membership_site_scopes
  USING (
    current_setting('app.platform_context', true) = 'true'
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.platform_context', true) = 'true'
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_api_keys ON api_keys
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_outbox ON outbox_events
  USING (
    current_setting('app.platform_context', true) = 'true'
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (
    current_setting('app.platform_context', true) = 'true'
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    (current_setting('app.platform_context', true) = 'true' AND tenant_id IS NULL)
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

-- 9. Attribution des privilèges minimaux au rôle nexus_app (aucun DELETE/UPDATE sur audit_logs)
GRANT SELECT, INSERT, UPDATE ON
  subscription_plans,
  tenants,
  tenant_subscriptions,
  sites,
  departments,
  users,
  mfa_factors,
  user_sessions,
  permissions,
  roles,
  tenant_memberships,
  api_keys,
  outbox_events
TO nexus_app;

GRANT SELECT, INSERT, DELETE ON role_permissions, membership_site_scopes, mfa_factors TO nexus_app;
GRANT SELECT, INSERT ON audit_logs TO nexus_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM nexus_app;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_seq_no_seq TO nexus_app;
