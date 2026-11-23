-- ============================================================================
-- NEXUS RH — Migration 0003 : Corrections contrôlées Vague 1 (Socle SQL)
-- Périmètre strict : F-04, G-01, N-01, N-02, B-04, B-06.
-- Migration 100 % additive et non destructive :
--   - aucune suppression de table, de colonne ni d'enregistrement historique ;
--   - contraintes CHECK ajoutées en NOT VALID puis validées conditionnellement
--     pour ne jamais bloquer une base existante contenant d'anciens dossiers ;
--   - déduplication non destructive des éventuels consentements GRANTED multiples
--     par passage en WITHDRAWN tracé avant création de l'index unique partiel ;
--   - compatible PostgreSQL 16 strict (aucune extension propriétaire, zéro flottant).
-- ============================================================================

-- ============================================================================
-- 1. G-01 & F-04 : Colonnes additives optionnelles (expatrié & échéances titres)
--    et verrous SQL de cohérence calendaire / preuve écrite biométrique
-- ============================================================================

-- Statut résident/expatrié explicite et optionnel (RF-M02-01) : NULL = non qualifié
-- (jamais déduit automatiquement de nationality_code ; validation RH/fiscale requise)
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_expatriate BOOLEAN NULL;

-- Date d'expiration optionnelle de la pièce d'identité / carte de résident / permis de travail
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS identity_doc_expires_at DATE NULL;

-- Date d'expiration optionnelle d'une pièce du coffre (visa ONEM, permis, aptitude médicale)
ALTER TABLE employee_documents
  ADD COLUMN IF NOT EXISTS expires_at DATE NULL;

DO $$
BEGIN
  -- Âge révolu exact >= 16 ans à la date d'embauche (mois et jour inclus)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_employees_min_hire_age_16'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT chk_employees_min_hire_age_16 CHECK (
        (
          EXTRACT(YEAR FROM hire_date)::int - EXTRACT(YEAR FROM birth_date)::int
          - CASE
              WHEN (EXTRACT(MONTH FROM hire_date)::int, EXTRACT(DAY FROM hire_date)::int)
                 < (EXTRACT(MONTH FROM birth_date)::int, EXTRACT(DAY FROM birth_date)::int)
              THEN 1
              ELSE 0
            END
        ) >= 16
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM employees
    WHERE (
      EXTRACT(YEAR FROM hire_date)::int - EXTRACT(YEAR FROM birth_date)::int
      - CASE
          WHEN (EXTRACT(MONTH FROM hire_date)::int, EXTRACT(DAY FROM hire_date)::int)
             < (EXTRACT(MONTH FROM birth_date)::int, EXTRACT(DAY FROM birth_date)::int)
          THEN 1
          ELSE 0
        END
    ) < 16
  ) THEN
    ALTER TABLE employees VALIDATE CONSTRAINT chk_employees_min_hire_age_16;
  ELSE
    RAISE NOTICE 'chk_employees_min_hire_age_16 conservée en NOT VALID : des dossiers historiques antérieurs requièrent une revue RH/juridique manuelle.';
  END IF;

  -- Cohérence de la date d'expiration du titre d'identité / permis de travail
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_employees_iddoc_expiry_coherent'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT chk_employees_iddoc_expiry_coherent CHECK (
        identity_doc_expires_at IS NULL
        OR (identity_doc_type IS NOT NULL AND identity_doc_expires_at > birth_date)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM employees
    WHERE identity_doc_expires_at IS NOT NULL
      AND (identity_doc_type IS NULL OR identity_doc_expires_at <= birth_date)
  ) THEN
    ALTER TABLE employees VALIDATE CONSTRAINT chk_employees_iddoc_expiry_coherent;
  END IF;

  -- Cohérence entre expiration d'une pièce et sa date de conservation minimale
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_documents_retention_after_expiry'
  ) THEN
    ALTER TABLE employee_documents
      ADD CONSTRAINT chk_documents_retention_after_expiry CHECK (
        expires_at IS NULL
        OR retention_until IS NULL
        OR retention_until >= expires_at
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM employee_documents
    WHERE expires_at IS NOT NULL
      AND retention_until IS NOT NULL
      AND retention_until < expires_at
  ) THEN
    ALTER TABLE employee_documents VALIDATE CONSTRAINT chk_documents_retention_after_expiry;
  END IF;

  -- Cohérence période d'essai <= date de fin prévue du contrat lorsqu'un terme existe
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_contracts_probation_within_term'
  ) THEN
    ALTER TABLE employment_contracts
      ADD CONSTRAINT chk_contracts_probation_within_term CHECK (
        probation_end_date IS NULL
        OR end_date IS NULL
        OR probation_end_date <= end_date
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM employment_contracts
    WHERE probation_end_date IS NOT NULL
      AND end_date IS NOT NULL
      AND probation_end_date > end_date
  ) THEN
    ALTER TABLE employment_contracts VALIDATE CONSTRAINT chk_contracts_probation_within_term;
  ELSE
    RAISE NOTICE 'chk_contracts_probation_within_term conservée en NOT VALID : des contrats existants requièrent une vérification RH.';
  END IF;

  -- Preuve écrite signée obligatoire pour tout consentement biométrique GRANTED
  -- (BIOMETRIC_DEVICE_ONLY et BIOMETRIC_CENTRAL_TEMPLATE — SECURITY_POLICY.md § 3.3 #1).
  -- N'altère aucun consentement historique existant et ne modifie pas les types non biométriques.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_consents_biometric_signed_doc'
  ) THEN
    ALTER TABLE employee_consents
      ADD CONSTRAINT chk_consents_biometric_signed_doc CHECK (
        consent_type NOT IN ('BIOMETRIC_DEVICE_ONLY', 'BIOMETRIC_CENTRAL_TEMPLATE')
        OR decision <> 'GRANTED'
        OR signed_document_id IS NOT NULL
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM employee_consents
    WHERE consent_type IN ('BIOMETRIC_DEVICE_ONLY', 'BIOMETRIC_CENTRAL_TEMPLATE')
      AND decision = 'GRANTED'
      AND signed_document_id IS NULL
  ) THEN
    ALTER TABLE employee_consents VALIDATE CONSTRAINT chk_consents_biometric_signed_doc;
  ELSE
    RAISE NOTICE 'chk_consents_biometric_signed_doc conservée en NOT VALID : des consentements biométriques antérieurs sans pièce jointe requièrent une régularisation RH.';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_employees_tenant_iddoc_expiry
  ON employees(tenant_id, identity_doc_expires_at)
  WHERE identity_doc_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_expiry
  ON employee_documents(tenant_id, expires_at)
  WHERE expires_at IS NOT NULL AND status = 'ACTIVE';

-- ============================================================================
-- 2. N-01 : Déduplication non destructive & unicité stricte d'un seul
--    consentement GRANTED actif par (tenant_id, employee_id, consent_type)
-- ============================================================================

-- Si des doublons GRANTED préexistent pour un même (tenant_id, employee_id, consent_type),
-- on conserve intact le plus récent (rn = 1) et on clôture les précédents en WITHDRAWN
-- avec motif explicite : AUCUN enregistrement historique n'est jamais supprimé.
CREATE OR REPLACE FUNCTION deduplicate_active_employee_consents()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_closed_count INTEGER := 0;
BEGIN
  WITH ranked_active AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY tenant_id, employee_id, consent_type
        ORDER BY decided_at DESC, created_at DESC, id DESC
      ) AS rn
    FROM employee_consents
    WHERE decision = 'GRANTED'
  )
  UPDATE employee_consents ec
  SET
    decision = 'WITHDRAWN',
    withdrawn_at = COALESCE(ec.withdrawn_at, NOW()),
    withdrawal_reason = COALESCE(
      ec.withdrawal_reason,
      'Régularisation non destructive (migration 0003) : doublon actif clôturé au profit du consentement GRANTED le plus récent (historique intégralement conservé).'
    ),
    updated_at = NOW()
  FROM ranked_active r
  WHERE ec.id = r.id
    AND r.rn > 1;

  GET DIAGNOSTICS v_closed_count = ROW_COUNT;
  RETURN v_closed_count;
END;
$$;

SELECT deduplicate_active_employee_consents();

-- Garantit mathématiquement au plus un consentement GRANTED simultané par type et par salarié,
-- tout en autorisant un historique illimité de décisions REFUSED et WITHDRAWN.
CREATE UNIQUE INDEX IF NOT EXISTS uq_consents_one_granted_per_type
  ON employee_consents(tenant_id, employee_id, consent_type)
  WHERE decision = 'GRANTED';

-- ============================================================================
-- 3. B-04 : Moindre privilège strict sur `permissions` et `employee_consents`
--    + déclencheur d'intégrité légale sur `employee_consents`
-- ============================================================================

-- Le catalogue `permissions` est alimenté en SELECT + INSERT uniquement (jamais d'UPDATE/DELETE)
REVOKE UPDATE, DELETE, TRUNCATE ON permissions FROM nexus_app;

-- Sur `employee_consents`, seules les colonnes de retrait peuvent être mises à jour ;
-- les colonnes constitutives de la preuve initiale sont strictement immuables.
REVOKE UPDATE, DELETE, TRUNCATE ON employee_consents FROM nexus_app;
GRANT UPDATE (
  decision,
  withdrawn_at,
  withdrawal_reason,
  withdrawn_by,
  updated_at
) ON employee_consents TO nexus_app;

CREATE OR REPLACE FUNCTION enforce_employee_consent_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INTÉGRITÉ CONSENTEMENT VIOLÉE : la suppression physique d’un consentement historique dans employee_consents est interdite.'
      USING ERRCODE = '42501';
  END IF;

  -- Interdiction absolue d'altérer les champs de la preuve initiale du recueil
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
    OR NEW.consent_type IS DISTINCT FROM OLD.consent_type
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.collection_method IS DISTINCT FROM OLD.collection_method
    OR NEW.notice_summary IS DISTINCT FROM OLD.notice_summary
    OR NEW.alternative_qr_pin_offered IS DISTINCT FROM OLD.alternative_qr_pin_offered
    OR NEW.signed_document_id IS DISTINCT FROM OLD.signed_document_id
    OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
    OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
    OR NEW.ip_address IS DISTINCT FROM OLD.ip_address
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'INTÉGRITÉ CONSENTEMENT VIOLÉE : les données probatoires initiales d’un consentement ne peuvent pas être modifiées.'
      USING ERRCODE = '42501';
  END IF;

  -- Seule la transition irréversible GRANTED -> WITHDRAWN est autorisée
  IF NOT (OLD.decision = 'GRANTED' AND NEW.decision = 'WITHDRAWN') THEN
    RAISE EXCEPTION 'TRANSITION CONSENTEMENT INTERDITE : seul le retrait d’un consentement actif (GRANTED -> WITHDRAWN) est permis (actuel: % -> %).',
      OLD.decision, NEW.decision
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_consents_legal_integrity ON employee_consents;
CREATE TRIGGER trg_employee_consents_legal_integrity
  BEFORE UPDATE OR DELETE ON employee_consents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_employee_consent_integrity();

-- ============================================================================
-- 4. N-02 : Réattribution propre des rôles révoqués avec conservation intégrale
--    de l'historique des révocations (`tenant_memberships`)
-- ============================================================================

ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;

ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS revoked_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS revoke_reason VARCHAR(300) NULL;

-- Renseigne de façon non destructive `revoked_at` sur d'éventuelles révocations antérieures
UPDATE tenant_memberships
SET revoked_at = COALESCE(revoked_at, updated_at)
WHERE status = 'REVOKED' AND revoked_at IS NULL;

-- Par précaution défensive avant index unique partiel : s'il existait plusieurs lignes
-- non révoquées pour (tenant_id, user_id, role_id), conserve la plus récente sans suppression.
WITH ranked_memberships AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, user_id, role_id
      ORDER BY (status = 'ACTIVE') DESC, created_at DESC, id DESC
    ) AS rn
  FROM tenant_memberships
  WHERE status IN ('ACTIVE', 'SUSPENDED')
)
UPDATE tenant_memberships tm
SET
  status = 'REVOKED',
  revoked_at = COALESCE(tm.revoked_at, NOW()),
  revoke_reason = COALESCE(
    tm.revoke_reason,
    'Régularisation non destructive (migration 0003) : doublon d’adhésion clôturé avec conservation historique.'
  ),
  updated_at = NOW()
FROM ranked_memberships r
WHERE tm.id = r.id
  AND r.rn > 1;

-- Remplace la contrainte globale bloquante par un index unique partiel sur les adhésions
-- non révoquées : interdit tout doublon ACTIVE/SUSPENDED tout en conservant toutes les
-- adhésions REVOKED historiques lors d'une réattribution ultérieure du même rôle.
ALTER TABLE tenant_memberships
  DROP CONSTRAINT IF EXISTS uq_membership_tenant_user_role;

CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_tenant_user_role_active
  ON tenant_memberships(tenant_id, user_id, role_id)
  WHERE status IN ('ACTIVE', 'SUSPENDED');

-- ============================================================================
-- 5. B-06 : Index de reprise transactionnelle pour le relayeur `outbox_events`
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_outbox_tenant_retryable
  ON outbox_events(tenant_id, status, next_attempt_at ASC)
  WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_outbox_global_retryable
  ON outbox_events(status, next_attempt_at ASC)
  WHERE status IN ('PENDING', 'FAILED');
