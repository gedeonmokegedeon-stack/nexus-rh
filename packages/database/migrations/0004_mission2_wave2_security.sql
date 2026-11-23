-- =============================================================================
-- NEXUS RH — Migration 0004 : Vague 2 — Durcissement IAM, MFA par Tenant & Délégations Bornées
-- =============================================================================
-- Correctifs couverts (additifs, idempotents, strictement non destructifs) :
--   * N-04 / C-03 : Isolation de l'obligation MFA par appartenance d'entreprise
--                   (`tenant_memberships.mfa_required`) sans contamination globale
--                   inter-tenants sur `users.mfa_required` (réservé au niveau plateforme).
--   * C-04        : Encadrement temporel et justification obligatoire des délégations
--                   support explicites autorisées par le client (`expires_at`,
--                   `support_justification`) et des accès auditeurs bornés dans le temps.
-- =============================================================================

-- 1. Colonnes additives sur tenant_memberships (RLS FORCE déjà actif depuis 0001)
ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS support_justification VARCHAR(500) NULL;

-- 2. Contrainte de cohérence chronologique sur l'échéance d'appartenance (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_memberships_expiry_after_created'
      AND conrelid = 'tenant_memberships'::regclass
  ) THEN
    ALTER TABLE tenant_memberships
      ADD CONSTRAINT chk_memberships_expiry_after_created
      CHECK (expires_at IS NULL OR expires_at > created_at);
  END IF;
END
$$;

-- 3. Rétro-propagation non destructive des obligations MFA existantes vers tenant_memberships :
--    a) Rôles standards à MFA obligatoire selon SECURITY_POLICY.md § 5.1
UPDATE tenant_memberships tm
SET mfa_required = TRUE,
    updated_at = NOW()
FROM roles r
WHERE r.id = tm.role_id
  AND tm.status IN ('ACTIVE', 'SUSPENDED')
  AND tm.mfa_required = FALSE
  AND r.code IN ('TENANT_ADMIN', 'PAYROLL_MANAGER', 'FINANCE_APPROVER', 'BIOMETRIC_ADMIN');

--    b) Comptes non Super-Admin précédemment marqués `users.mfa_required = TRUE` :
--       transfère l'exigence sur leurs appartenances actives/suspendues existantes,
--       puis libère le drapeau global `users.mfa_required` pour éviter toute fuite inter-tenant (N-04).
UPDATE tenant_memberships tm
SET mfa_required = TRUE,
    updated_at = NOW()
FROM users u
WHERE u.id = tm.user_id
  AND u.is_platform_superadmin = FALSE
  AND u.mfa_required = TRUE
  AND tm.status IN ('ACTIVE', 'SUSPENDED')
  AND tm.mfa_required = FALSE;

UPDATE users u
SET mfa_required = FALSE,
    updated_at = NOW()
WHERE u.is_platform_superadmin = FALSE
  AND u.mfa_required = TRUE
  AND EXISTS (
    SELECT 1
    FROM tenant_memberships tm
    WHERE tm.user_id = u.id
      AND tm.status IN ('ACTIVE', 'SUSPENDED')
      AND tm.mfa_required = TRUE
  );

-- 4. Index partiel pour la vérification rapide des appartenances actives et non expirées
CREATE INDEX IF NOT EXISTS idx_memberships_tenant_user_active_expiry
  ON tenant_memberships (tenant_id, user_id, expires_at)
  WHERE status = 'ACTIVE';
