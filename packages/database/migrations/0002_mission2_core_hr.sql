-- ============================================================================
-- NEXUS RH — Migration 0002 : Mission 2 (Cœur RH RDC)
-- Postes & Catégories RDC, Compteurs Atomiques de Matricules, Dossiers Employés
-- (PII & Paiement chiffrés AES-256-GCM + Index Aveugles HMAC), Ayants droit,
-- Contrats de Travail RDC (salaire chiffré, visa ONEM, suivi renouvellements CDD),
-- Badges QR + Code PIN Argon2id (alternative non-biométrique garantie),
-- Coffre Documentaire S3 (empreinte SHA-256 + préfixe tenant verrouillé en SQL)
-- et Registre Légal des Consentements RDC (jamais précoché, révocable à tout moment).
-- Toutes les 8 tables activent ENABLE + FORCE ROW LEVEL SECURITY (total = 18).
-- Compatible PostgreSQL 16 strict (aucune extension propriétaire, aucun flottant).
-- ============================================================================

-- 1. Postes & Catégories professionnelles RDC (sans barème salarial codé en dur)
CREATE TABLE job_positions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  department_id UUID NULL,
  code VARCHAR(32) NOT NULL,
  title VARCHAR(160) NOT NULL,
  professional_category VARCHAR(40) NOT NULL CHECK (
    professional_category IN (
      'MANOEUVRE_ORDINAIRE',
      'MANOEUVRE_LOURD',
      'TRAVAILLEUR_SEMI_QUALIFIE',
      'TRAVAILLEUR_QUALIFIE',
      'TRAVAILLEUR_HAUTEMENT_QUALIFIE',
      'AGENT_DE_MAITRISE',
      'CADRE_COLLABORATION',
      'CADRE_DIRECTION'
    )
  ),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_job_positions_tenant_code UNIQUE (tenant_id, code),
  CONSTRAINT uq_job_positions_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_job_positions_department FOREIGN KEY (department_id, tenant_id)
    REFERENCES departments(id, tenant_id) ON DELETE RESTRICT
);

-- 2. Compteurs séquentiels atomiques de matricules (zéro collision concurrente)
CREATE TABLE matricule_counters (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scope_key VARCHAR(96) NOT NULL,
  last_value BIGINT NOT NULL CHECK (last_value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, scope_key)
);

-- 3. Dossiers Employés RDC (zéro gabarit biométrique ; PII & paiement chiffrés par enveloppe)
CREATE TABLE employees (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  matricule VARCHAR(80) NOT NULL,
  primary_site_id UUID NOT NULL,
  department_id UUID NULL,
  job_position_id UUID NULL,
  manager_employee_id UUID NULL,
  user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  -- État civil congolais (Nom, Post-nom, Prénom)
  last_name VARCHAR(100) NOT NULL,
  post_name VARCHAR(100) NULL,
  first_name VARCHAR(100) NOT NULL,
  gender CHAR(1) NOT NULL CHECK (gender IN ('F', 'M')),
  birth_date DATE NOT NULL,
  birth_place VARCHAR(120) NULL,
  nationality_code CHAR(2) NOT NULL DEFAULT 'CD',
  marital_status VARCHAR(24) NOT NULL DEFAULT 'SINGLE' CHECK (
    marital_status IN ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'LEGAL_SEPARATION')
  ),
  tax_dependents_count SMALLINT NOT NULL DEFAULT 0 CHECK (tax_dependents_count >= 0 AND tax_dependents_count <= 30),
  hire_date DATE NOT NULL,
  termination_date DATE NULL,
  termination_reason TEXT NULL,
  work_email VARCHAR(255) NULL CHECK (work_email IS NULL OR work_email = lower(work_email)),
  phone_primary VARCHAR(32) NULL,
  province VARCHAR(80) NULL,
  city VARCHAR(100) NULL,
  commune VARCHAR(100) NULL,
  address_line TEXT NULL,
  emergency_contact_name VARCHAR(160) NULL,
  emergency_contact_phone VARCHAR(32) NULL,
  -- Identifiants RDC sensibles : aperçu masqué + enveloppe AES-256-GCM + index aveugles HMAC
  identity_doc_type VARCHAR(32) NULL CHECK (
    identity_doc_type IS NULL OR identity_doc_type IN (
      'CARTE_ELECTEUR_CENI',
      'CARTE_IDENTITE_ONIP',
      'PASSEPORT',
      'CARTE_RESIDENT',
      'PERMIS_TRAVAIL_ETRANGER'
    )
  ),
  identity_doc_masked VARCHAR(32) NULL,
  cnss_number_masked VARCHAR(32) NULL,
  individual_tax_id_masked VARCHAR(32) NULL,
  encrypted_pii JSONB NULL,
  cnss_blind_index CHAR(64) NULL,
  identity_doc_blind_index CHAR(64) NULL,
  -- Coordonnées de paiement : aperçu masqué + enveloppe AES-256-GCM
  payment_method VARCHAR(24) NOT NULL DEFAULT 'BANK_TRANSFER' CHECK (
    payment_method IN ('BANK_TRANSFER', 'MOBILE_MONEY', 'CASH')
  ),
  bank_name VARCHAR(120) NULL,
  bank_account_masked VARCHAR(32) NULL,
  mobile_money_operator VARCHAR(24) NULL CHECK (
    mobile_money_operator IS NULL OR mobile_money_operator IN (
      'MPESA', 'AIRTEL_MONEY', 'ORANGE_MONEY', 'AFRIMONEY'
    )
  ),
  mobile_money_masked VARCHAR(32) NULL,
  encrypted_payment JSONB NULL,
  -- Mode de pointage : QR+PIN obligatoire par défaut ; alternative toujours garantie
  attendance_mode VARCHAR(24) NOT NULL DEFAULT 'QR_PIN_ONLY' CHECK (
    attendance_mode IN ('QR_PIN_ONLY', 'BIOMETRIC_OR_QR_PIN')
  ),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('DRAFT', 'ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED')
  ),
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_employees_tenant_matricule UNIQUE (tenant_id, matricule),
  CONSTRAINT uq_employees_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_employees_site FOREIGN KEY (primary_site_id, tenant_id)
    REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_employees_department FOREIGN KEY (department_id, tenant_id)
    REFERENCES departments(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_employees_position FOREIGN KEY (job_position_id, tenant_id)
    REFERENCES job_positions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_employees_manager FOREIGN KEY (manager_employee_id, tenant_id)
    REFERENCES employees(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_employees_not_self_manager CHECK (
    manager_employee_id IS NULL OR manager_employee_id <> id
  ),
  CONSTRAINT chk_employees_hire_after_birth CHECK (hire_date > birth_date),
  CONSTRAINT chk_employees_termination_lock CHECK (
    (status <> 'TERMINATED')
    OR (termination_date IS NOT NULL AND termination_reason IS NOT NULL AND length(btrim(termination_reason)) >= 5)
  )
);

CREATE UNIQUE INDEX uq_employees_tenant_cnss_blind
  ON employees(tenant_id, cnss_blind_index)
  WHERE cnss_blind_index IS NOT NULL;

CREATE UNIQUE INDEX uq_employees_tenant_iddoc_blind
  ON employees(tenant_id, identity_doc_blind_index)
  WHERE identity_doc_blind_index IS NOT NULL;

CREATE UNIQUE INDEX uq_employees_tenant_user
  ON employees(tenant_id, user_id)
  WHERE user_id IS NOT NULL;

-- 4. Famille & Ayants droit RDC (préparation charges IPR & allocations familiales sans taux en dur)
CREATE TABLE employee_dependents (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  relationship VARCHAR(24) NOT NULL CHECK (
    relationship IN ('SPOUSE', 'CHILD_LEGITIMATE', 'CHILD_RECOGNIZED', 'LEGAL_WARD')
  ),
  birth_date DATE NULL,
  is_tax_dependent BOOLEAN NOT NULL DEFAULT TRUE,
  is_pf_beneficiary BOOLEAN NOT NULL DEFAULT TRUE,
  notes VARCHAR(400) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_dependents_employee FOREIGN KEY (employee_id, tenant_id)
    REFERENCES employees(id, tenant_id) ON DELETE RESTRICT
);

-- 5. Coffre Documentaire S3 isolé par tenant (SHA-256 + enveloppe AES-256-GCM)
CREATE TABLE employee_documents (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL,
  category VARCHAR(32) NOT NULL CHECK (
    category IN (
      'IDENTITY_DOC',
      'EMPLOYMENT_CONTRACT',
      'CONTRACT_AMENDMENT',
      'ONEM_VISA',
      'CNSS_CARD',
      'DIPLOMA_CERTIFICATE',
      'MEDICAL_FITNESS',
      'SIGNED_CONSENT',
      'DISCIPLINARY',
      'OTHER'
    )
  ),
  title VARCHAR(160) NOT NULL,
  original_filename VARCHAR(200) NOT NULL,
  mime_type VARCHAR(80) NOT NULL CHECK (
    mime_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')
  ),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  sha256_checksum CHAR(64) NOT NULL,
  storage_bucket VARCHAR(120) NOT NULL,
  object_key VARCHAR(512) NOT NULL UNIQUE,
  is_envelope_encrypted BOOLEAN NOT NULL DEFAULT TRUE,
  retention_until DATE NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DELETED')),
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ NULL,
  delete_reason VARCHAR(400) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_employee_documents_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT uq_employee_documents_id_employee_tenant UNIQUE (id, employee_id, tenant_id),
  CONSTRAINT fk_documents_employee FOREIGN KEY (employee_id, tenant_id)
    REFERENCES employees(id, tenant_id) ON DELETE RESTRICT,
  -- Verrou SQL anti-traversée et anti-fuite S3 : clé strictement cloisonnée par tenant et employé
  CONSTRAINT chk_documents_tenant_key_prefix CHECK (
    object_key LIKE ('tenants/' || tenant_id::text || '/employees/' || employee_id::text || '/documents/%')
    AND position('..' in object_key) = 0
  ),
  CONSTRAINT chk_documents_delete_reason CHECK (
    (status <> 'DELETED')
    OR (deleted_at IS NOT NULL AND delete_reason IS NOT NULL AND length(btrim(delete_reason)) >= 5)
  )
);

-- 6. Contrats de travail RDC (salaire de base chiffré AES-256-GCM, un seul contrat ACTIVE par employé)
CREATE TABLE employment_contracts (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL,
  site_id UUID NOT NULL,
  job_position_id UUID NULL,
  contract_number VARCHAR(64) NOT NULL,
  contract_type VARCHAR(24) NOT NULL CHECK (
    contract_type IN ('CDI', 'CDD', 'JOURNALIER', 'STAGE_PROFESSIONNEL', 'CONSULTANT', 'INTERIM')
  ),
  start_date DATE NOT NULL,
  end_date DATE NULL,
  probation_end_date DATE NULL,
  cdd_renewal_count SMALLINT NOT NULL DEFAULT 0 CHECK (cdd_renewal_count >= 0 AND cdd_renewal_count <= 10),
  weekly_hours NUMERIC(5, 2) NOT NULL DEFAULT 45.00 CHECK (weekly_hours > 0 AND weekly_hours <= 72),
  pay_currency CHAR(3) NOT NULL CHECK (pay_currency IN ('CDF', 'USD', 'EUR')),
  pay_frequency VARCHAR(16) NOT NULL DEFAULT 'MONTHLY' CHECK (
    pay_frequency IN ('MONTHLY', 'BIWEEKLY', 'DAILY')
  ),
  encrypted_base_salary JSONB NOT NULL,
  hiring_place VARCHAR(120) NOT NULL,
  onem_visa_ref VARCHAR(80) NULL,
  onem_visa_date DATE NULL,
  signed_document_id UUID NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'TERMINATED')
  ),
  status_reason VARCHAR(500) NULL,
  terminated_at TIMESTAMPTZ NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_contracts_tenant_number UNIQUE (tenant_id, contract_number),
  CONSTRAINT fk_contracts_employee FOREIGN KEY (employee_id, tenant_id)
    REFERENCES employees(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts_site FOREIGN KEY (site_id, tenant_id)
    REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts_position FOREIGN KEY (job_position_id, tenant_id)
    REFERENCES job_positions(id, tenant_id) ON DELETE RESTRICT,
  -- Garantit que le document signé appartient au MÊME employé et au MÊME tenant (anti-IDOR SQL)
  CONSTRAINT fk_contracts_signed_doc FOREIGN KEY (signed_document_id, employee_id, tenant_id)
    REFERENCES employee_documents(id, employee_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_contracts_dates CHECK (
    (contract_type <> 'CDI' OR end_date IS NULL)
    AND (end_date IS NULL OR end_date >= start_date)
    AND (probation_end_date IS NULL OR probation_end_date >= start_date)
  )
);

CREATE UNIQUE INDEX uq_contracts_one_active_per_employee
  ON employment_contracts(tenant_id, employee_id)
  WHERE status = 'ACTIVE';

-- 7. Badges d'identification QR + Code PIN Argon2id (alternative fonctionnelle à la biométrie)
CREATE TABLE employee_attendance_badges (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL,
  site_id UUID NOT NULL,
  badge_code VARCHAR(48) NOT NULL,
  qr_token_hash CHAR(64) NOT NULL UNIQUE,
  pin_argon2_hash TEXT NOT NULL,
  failed_pin_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_pin_attempts >= 0),
  pin_locked_until TIMESTAMPTZ NULL,
  last_verified_at TIMESTAMPTZ NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('ACTIVE', 'REVOKED', 'LOST', 'EXPIRED')
  ),
  issued_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at DATE NULL,
  revoked_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoke_reason VARCHAR(300) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_badges_tenant_code UNIQUE (tenant_id, badge_code),
  CONSTRAINT fk_badges_employee FOREIGN KEY (employee_id, tenant_id)
    REFERENCES employees(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_badges_site FOREIGN KEY (site_id, tenant_id)
    REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_badges_revoke_lock CHECK (
    (status NOT IN ('REVOKED', 'LOST'))
    OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) >= 5)
  )
);

CREATE UNIQUE INDEX uq_badges_one_active_per_employee
  ON employee_attendance_badges(tenant_id, employee_id)
  WHERE status = 'ACTIVE';

-- 8. Registre légal des consentements RDC (Ordonnance-Loi n° 23/010 — jamais précoché, révocable)
CREATE TABLE employee_consents (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL,
  consent_type VARCHAR(40) NOT NULL CHECK (
    consent_type IN (
      'PERSONAL_DATA_PROCESSING',
      'BIOMETRIC_DEVICE_ONLY',
      'BIOMETRIC_CENTRAL_TEMPLATE',
      'BADGE_PHOTO',
      'ATTENDANCE_GEOLOCATION',
      'ELECTRONIC_PAYSLIP'
    )
  ),
  decision VARCHAR(16) NOT NULL CHECK (decision IN ('GRANTED', 'REFUSED', 'WITHDRAWN')),
  policy_version VARCHAR(40) NOT NULL,
  collection_method VARCHAR(32) NOT NULL CHECK (
    collection_method IN ('WRITTEN_SIGNED_UPLOAD', 'HR_ATTESTED_PAPER', 'EMPLOYEE_PORTAL_EXPLICIT')
  ),
  notice_summary TEXT NOT NULL,
  alternative_qr_pin_offered BOOLEAN NOT NULL CHECK (alternative_qr_pin_offered = TRUE),
  signed_document_id UUID NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ NULL,
  withdrawal_reason VARCHAR(500) NULL,
  recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  withdrawn_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ip_address VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_consents_employee FOREIGN KEY (employee_id, tenant_id)
    REFERENCES employees(id, tenant_id) ON DELETE RESTRICT,
  -- Garantit que le document signé appartient strictement au même employé et au même tenant
  CONSTRAINT fk_consents_signed_doc FOREIGN KEY (signed_document_id, employee_id, tenant_id)
    REFERENCES employee_documents(id, employee_id, tenant_id) ON DELETE RESTRICT,
  -- Verrou SQL : aucun consentement biométrique central sans pièce écrite signée
  CONSTRAINT chk_consents_central_biometric_doc CHECK (
    consent_type <> 'BIOMETRIC_CENTRAL_TEMPLATE'
    OR decision <> 'GRANTED'
    OR signed_document_id IS NOT NULL
  ),
  CONSTRAINT chk_consents_withdrawal CHECK (
    (decision <> 'WITHDRAWN')
    OR (withdrawn_at IS NOT NULL AND withdrawal_reason IS NOT NULL AND length(btrim(withdrawal_reason)) >= 5)
  )
);

-- 9. Index composites multi-tenant (tenant_id systématiquement en tête)
CREATE INDEX idx_job_positions_tenant_dept ON job_positions(tenant_id, department_id, status);
CREATE INDEX idx_employees_tenant_site_status ON employees(tenant_id, primary_site_id, status);
CREATE INDEX idx_employees_tenant_name ON employees(tenant_id, last_name, post_name, first_name);
CREATE INDEX idx_dependents_tenant_employee ON employee_dependents(tenant_id, employee_id, status);
CREATE INDEX idx_contracts_tenant_employee ON employment_contracts(tenant_id, employee_id, status);
CREATE INDEX idx_contracts_tenant_site ON employment_contracts(tenant_id, site_id, status);
CREATE INDEX idx_badges_tenant_employee ON employee_attendance_badges(tenant_id, employee_id, status);
CREATE INDEX idx_documents_tenant_employee ON employee_documents(tenant_id, employee_id, status);
CREATE INDEX idx_consents_tenant_employee_type ON employee_consents(tenant_id, employee_id, consent_type, decided_at DESC);

-- 10. Activation stricte ENABLE + FORCE ROW LEVEL SECURITY sur les 8 nouvelles tables

ALTER TABLE job_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_positions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_job_positions ON job_positions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE matricule_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE matricule_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_matricule_counters ON matricule_counters
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employees ON employees
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE employee_dependents ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_dependents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employee_dependents ON employee_dependents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE employment_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employment_contracts ON employment_contracts
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE employee_attendance_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_attendance_badges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employee_badges ON employee_attendance_badges
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employee_documents ON employee_documents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE employee_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employee_consents ON employee_consents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 11. Attribution du moindre privilège strict à nexus_app (aucun DELETE physique sur dossiers RH)
GRANT SELECT, INSERT, UPDATE ON
  job_positions,
  matricule_counters,
  employees,
  employee_dependents,
  employment_contracts,
  employee_attendance_badges,
  employee_documents,
  employee_consents
TO nexus_app;
