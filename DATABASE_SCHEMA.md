# SCHÉMA DE BASE DE DONNÉES — NEXUS RH

## 1. Conventions et règles structurantes

Le modèle de données de **NEXUS RH** est conçu pour **PostgreSQL 16/17** selon les règles impératives suivantes :

1. **Clés primaires** : `UUID` (format **UUIDv7** ordonné temporellement pour éviter la fragmentation des index B-Tree sur les tables à fort volume comme les pointages et les bulletins).
2. **Isolation multi-tenant systématique** : toutes les tables métier possèdent `tenant_id UUID NOT NULL REFERENCES tenants(id)` en tête de leurs index composites, protégé par `ENABLE ROW LEVEL SECURITY` et `FORCE ROW LEVEL SECURITY`.
3. **Horodatages** : toutes les colonnes temporelles d'instant sont en `TIMESTAMPTZ` (UTC). Les dates civiles (naissance, embauche, jour de pointage local, période de paie) sont en `DATE`. Les heures d'horaires sont en `TIME`. Le fuseau horaire IANA (`Africa/Kinshasa`, `Africa/Lubumbashi`, etc.) est stocké en `VARCHAR(64)` sur chaque établissement et terminal.
4. **Montants financiers et taux** : strictement `NUMERIC(18, 4)` pour les montants et bases, `NUMERIC(12, 6)` pour les taux et coefficients, `NUMERIC(18, 6)` pour les taux de change. **Aucun type `REAL` ou `DOUBLE PRECISION` n'est autorisé.**
5. **Immuabilité des preuves** : les tables `attendance_raw_events`, `audit_logs`, ainsi que `payroll_runs`, `payroll_payslips` et `payroll_payslip_lines` une fois au statut `LOCKED`, sont protégées par déclencheurs SQL (`TRIGGER`) interdisant tout `UPDATE` destructif ou `DELETE`. Toute correction passe par une écriture de régularisation référencée.
6. **Suppression logique contrôlée** : les référentiels (sites, agents, rubriques) utilisent un statut (`ACTIVE`, `INACTIVE`, `ARCHIVED`) ou `archived_at TIMESTAMPTZ` afin de ne jamais briser l'historique de paie. Exception légale : `biometric_templates` subit une **suppression cryptographique et physique immédiate** au retrait du consentement ou à la fin du contrat, seule la trace de purge subsistant dans `biometric_consents` et `audit_logs`.
7. **Traçabilité des simulations** : les événements et terminaux de test portent `is_simulated BOOLEAN NOT NULL DEFAULT FALSE`, avec contrainte empêchant leur agrégation dans une paie réelle.

---

## 2. Vue relationnelle synthétique des domaines

```text
[D1. PLATEFORME & TENANTS]
  subscription_plans ──< tenant_subscriptions >── tenants
  tenants ──< sites (timezone WAT/CAT) ──< departments ──< job_positions
  tenants ──< job_categories (grille RDC)   tenants ──< cost_centers

[D2. IDENTITÉ, RBAC & SÉCURITÉ]
  users ──< tenant_memberships >── roles ──< role_permissions >── permissions
  tenant_memberships ──< membership_site_scopes >── sites
  users ──< user_sessions / mfa_factors     tenants ──< api_keys

[D3. AGENTS, CONTRATS, BADGES & DOCUMENTS]
  tenants/sites ──< employees ──< employee_dependents
  employees ──< employment_contracts ──< contract_amendments
  employees ──< employee_payment_methods    employees ──< documents (S3)
  employees ──< employee_badges (QR signé)  employees ──1 employee_pins (Argon2id)

[D4. BIOMÉTRIE, PARC APPAREILS & KIOSQUES]
  employees ──< biometric_consents ──< biometric_templates (AES-256-GCM)
  sites ──< biometric_devices ──< device_commands / device_sync_logs
  sites ──< edge_agents                     sites ──< kiosk_terminals

[D5. PRÉSENCES, HORAIRES, CONGÉS & GTA]
  biometric_devices/kiosk_terminals ──< attendance_raw_events (partitionnée/mois)
  employees ──< attendance_daily_summaries ──< attendance_adjustments
  tenants ──< work_schedules ──< shift_templates ──< employee_shift_assignments
  tenants/sites ──< public_holidays         employees ──< overtime_records
  tenants ──< leave_types ──< leave_balances / leave_requests ──< leave_approvals
  tenants/sites ──< attendance_period_closures

[D6. PAIE RDC PARAMÉTRABLE, PRÊTS & BULLETINS]
  currencies ──< exchange_rates (BCC / paie, versionnés)
  payroll_rule_sets (versionnés) ──< smig_schedules
                                 ──< payroll_rubrics
                                 ──< payroll_contribution_rules (CNSS, INPP, ONEM...)
                                 ──< payroll_tax_regimes (IPR, IERE...) ──< payroll_tax_brackets
                                 ──< payroll_exemption_caps (logement, transport/ville...)
                                 ──< overtime_rate_rules / garnishment_rules
  employees ──< employee_recurring_items / employee_loans ──< loan_installments / salary_advances
  payroll_periods ──< payroll_runs (snapshot règles & taux) ──< payroll_payslips ──< payroll_payslip_lines
  employment_contracts ──< final_settlements (décompte final)

[D7. AUDIT IMMUABLE, INTÉGRATIONS & NOTIFICATIONS]
  audit_logs (chaîné SHA-256, partitionné)  outbox_events
  notifications                             webhook_endpoints ──< webhook_deliveries
```

---

## 3. Catalogue détaillé des tables par domaine

### Domaine D1 — Plateforme SaaS, Entreprises et Organisation

#### `tenants` (Entreprises clientes)
- `id` UUID PK
- `slug` VARCHAR(63) UNIQUE NOT NULL *(identifiant URL unique)*
- `legal_name` VARCHAR(255) NOT NULL, `trade_name` VARCHAR(255)
- `legal_form` VARCHAR(50) NOT NULL *(`SARL`, `SA`, `SAS`, `ETS`, `ASBL`, `ONG`, `PUBLIC_ENT`, `OTHER`)*
- `country_code` CHAR(2) NOT NULL DEFAULT `'CD'`
- `rccm` VARCHAR(100), `id_nat` VARCHAR(100), `tax_id_dgi` VARCHAR(100)
- `cnss_employer_number` VARCHAR(100), `inpp_employer_number` VARCHAR(100), `onem_employer_number` VARCHAR(100)
- `sector_code` VARCHAR(50) *(`GENERAL`, `MINING`, `BANKING`, `HEALTH`, `EDUCATION`, `CONSTRUCTION`, `SECURITY`, `NGO`, etc.)*
- `default_currency` CHAR(3) NOT NULL DEFAULT `'CDF'`
- `matricule_pattern` VARCHAR(120) NOT NULL DEFAULT `'{SITE}-{YYYY}-{SEQ:5}'`
- `logo_document_id` UUID NULL, `encryption_key_ref` VARCHAR(255) NOT NULL *(référence clé d'enveloppe KMS/KEK)*
- `biometric_storage_policy` VARCHAR(24) NOT NULL DEFAULT `'DEVICE_ONLY'` *(`DEVICE_ONLY` par défaut strict ; `ENCRYPTED_CENTRAL_SYNC` interdit sans autorisation juridique et validation explicite)*
- `central_template_storage_enabled` BOOLEAN NOT NULL DEFAULT FALSE *(bloqué à `FALSE` tant que `biometric_legal_authorization_ref` et `biometric_policy_approved_at` sont `NULL` — contrainte `CHECK` SQL)*
- `biometric_legal_authorization_ref` VARCHAR(160) NULL, `biometric_policy_approved_by` UUID NULL, `biometric_policy_approved_at` TIMESTAMPTZ NULL
- `status` VARCHAR(24) NOT NULL *(`TRIAL`, `ACTIVE`, `SUSPENDED`, `OFFBOARDING`, `CLOSED`)*
- `is_demo_tenant` BOOLEAN NOT NULL DEFAULT FALSE *(sépare strictement tout environnement de démonstration)*
- `created_at`, `updated_at` TIMESTAMPTZ NOT NULL

#### `subscription_plans` & `tenant_subscriptions`
- **`subscription_plans`** : `id`, `code` UNIQUE, `name`, `max_active_employees`, `max_sites`, `max_biometric_devices`, `storage_quota_bytes`, `enabled_modules` JSONB, `base_price`, `price_per_employee`, `currency`, `is_active`, `created_at`.
- **`tenant_subscriptions`** : `id`, `tenant_id`, `plan_id`, `status` (`TRIAL`, `ACTIVE`, `PAST_DUE`, `CANCELLED`), `billing_cycle` (`MONTHLY`, `ANNUAL`), `starts_at`, `ends_at`, `custom_overrides` JSONB, `created_at`, `updated_at`.

#### `sites` (Établissements / Succursales / Chantiers)
- `id` UUID PK, `tenant_id` UUID NOT NULL
- `code` VARCHAR(32) NOT NULL *(UNIQUE par `tenant_id`, ex. `KIN-HQ`, `LUB-01`, `KWZ-MINE`)*
- `name` VARCHAR(200) NOT NULL, `site_type` VARCHAR(40) *(`HEADQUARTERS`, `BRANCH`, `PLANT`, `WAREHOUSE`, `MINE_SITE`, `WORKSITE`, `CLINIC`, `CAMPUS`)*
- `province` VARCHAR(80) NOT NULL *(les 26 provinces de la RDC paramétrées)*, `city` VARCHAR(100) NOT NULL, `commune` VARCHAR(100), `address_line` TEXT
- `timezone` VARCHAR(64) NOT NULL *(`Africa/Kinshasa` ou `Africa/Lubumbashi`, validé IANA)*
- `latitude` NUMERIC(9, 6), `longitude` NUMERIC(9, 6), `geofence_radius_meters` INTEGER
- `transport_zone_code` VARCHAR(40) *(référence pour le plafond légal de transport local)*
- `is_headquarters` BOOLEAN NOT NULL DEFAULT FALSE, `status` VARCHAR(20) NOT NULL DEFAULT `'ACTIVE'`
- `created_at`, `updated_at` TIMESTAMPTZ NOT NULL

#### `departments`, `job_positions`, `job_categories`, `cost_centers`, `matricule_sequences`
- **`departments`** : `id`, `tenant_id`, `site_id` (nullable si transverse), `parent_department_id` (auto-référence), `code`, `name`, `manager_employee_id`, `status`, `created_at`, `updated_at`.
- **`job_categories`** : `id`, `tenant_id`, `code` (ex. `I-1`, `I-2`, `II`, `III-1`, `IV`, `V`, `M1`, `C1` selon classification RDC), `label`, `group_type` (`EXECUTION`, `MASTERY`, `COLLABORATION_CADRE`, `SENIOR_CADRE`), `tension_coefficient` NUMERIC(10, 4), `daily_transport_trips` SMALLINT, `transport_mode` (`BUS`, `TAXI`, `COMPANY_VEHICLE`), `rank_order` INTEGER.
- **`job_positions`** : `id`, `tenant_id`, `department_id`, `default_category_id`, `code`, `title`, `description`, `headcount_budget` INTEGER, `status`.
- **`cost_centers`** : `id`, `tenant_id`, `code`, `name`, `donor_or_project_ref` VARCHAR(120), `syscohada_analytic_code` VARCHAR(50), `valid_from`, `valid_to`, `status`.
- **`matricule_sequences`** : `id`, `tenant_id`, `scope_key` VARCHAR(100), `last_value` BIGINT NOT NULL DEFAULT 0 *(incrémenté atomiquement via `UPDATE ... RETURNING` pour garantir zéro doublon)*.

---

### Domaine D2 — Identité, Contrôle d'Accès (RBAC/ABAC) et Clés API

- **`users`** : `id`, `email` CITEXT UNIQUE, `phone` VARCHAR(32), `password_hash` TEXT (Argon2id), `full_name`, `is_platform_superadmin` BOOLEAN DEFAULT FALSE, `mfa_required` BOOLEAN DEFAULT FALSE, `mfa_enabled` BOOLEAN DEFAULT FALSE, `failed_login_count` SMALLINT DEFAULT 0, `locked_until` TIMESTAMPTZ, `password_changed_at` TIMESTAMPTZ, `last_login_at` TIMESTAMPTZ, `status` (`ACTIVE`, `LOCKED`, `DISABLED`), `created_at`, `updated_at`.
- **`mfa_factors`** : `id`, `user_id`, `factor_type` (`TOTP`, `RECOVERY_CODES`), `encrypted_secret` BYTEA, `verified_at`, `last_used_at`.
- **`user_sessions`** : `id`, `user_id`, `active_tenant_id`, `refresh_token_hash` CHAR(64) UNIQUE, `token_family_id` UUID *(détection de vol de refresh token)*, `ip_address` INET, `user_agent` TEXT, `expires_at`, `revoked_at`, `created_at`.
- **`roles`** : `id`, `tenant_id` (NULL pour modèles système), `code`, `name`, `description`, `is_system` BOOLEAN, `created_at`.
- **`permissions`** : `id`, `code` UNIQUE *(ex. `employees.read`, `employees.write_salary`, `attendance.adjust`, `attendance.approve`, `biometrics.consent.manage`, `biometrics.template.enroll`, `payroll.rules.manage`, `payroll.run.calculate`, `payroll.run.approve`, `payroll.run.lock`, `payslips.read_all`, `audit.read`)*, `module`, `description`, `is_sensitive` BOOLEAN.
- **`role_permissions`** : `(role_id, permission_id)` PK.
- **`tenant_memberships`** : `id`, `tenant_id`, `user_id`, `role_id`, `employee_id` UUID NULL *(lien vers son propre dossier agent pour ESS et règles anti-auto-approbation)*, `scope_type` (`ALL_SITES`, `SELECTED_SITES`, `OWN_DEPARTMENT`, `SELF_ONLY`), `status`, `created_at`, UNIQUE `(tenant_id, user_id, role_id)`.
- **`membership_site_scopes`** : `(membership_id, site_id)` PK, `tenant_id` NOT NULL.
- **`api_keys`** : `id`, `tenant_id`, `name`, `key_prefix` VARCHAR(16), `key_hash` CHAR(64) UNIQUE, `scopes` TEXT[], `allowed_ips` CIDR[], `rate_limit_per_min` INTEGER, `expires_at`, `last_used_at`, `revoked_at`, `created_by`, `created_at`.

---

### Domaine D3 — Agents, Contrats, Badges QR, PIN et Documents

#### `employees`
- `id` UUID PK, `tenant_id` UUID NOT NULL
- `matricule` VARCHAR(64) NOT NULL — **UNIQUE `(tenant_id, matricule)`**
- `primary_site_id` UUID NOT NULL REFERENCES `sites(id)`
- `department_id` UUID REFERENCES `departments(id)`, `job_position_id` UUID REFERENCES `job_positions(id)`, `job_category_id` UUID REFERENCES `job_categories(id)`, `cost_center_id` UUID REFERENCES `cost_centers(id)`, `manager_employee_id` UUID REFERENCES `employees(id)`
- `first_name` VARCHAR(120) NOT NULL, `last_name` VARCHAR(120) NOT NULL *(nom)*, `post_name` VARCHAR(120) *(post-nom — usage officiel en RDC)*
- `gender` CHAR(1) *(`M`, `F`)*, `birth_date` DATE, `birth_place` VARCHAR(120)
- `nationality_code` CHAR(2) NOT NULL, `is_expatriate` BOOLEAN NOT NULL DEFAULT FALSE, `work_permit_number` VARCHAR(100), `work_permit_expires_at` DATE
- `marital_status` VARCHAR(24) *(`SINGLE`, `MARRIED`, `DIVORCED`, `WIDOWED`)*
- `national_id_type` VARCHAR(32) *(`VOTER_CARD`, `NATIONAL_ID`, `PASSPORT`, `RESIDENCE_CARD`)*, `national_id_number` VARCHAR(100)
- `cnss_number` VARCHAR(100), `tax_id_number` VARCHAR(100)
- `work_email` VARCHAR(255), `personal_email` VARCHAR(255), `phone_primary` VARCHAR(32), `phone_secondary` VARCHAR(32), `residential_address` TEXT
- `emergency_contact_name` VARCHAR(160), `emergency_contact_phone` VARCHAR(32), `emergency_contact_relation` VARCHAR(60)
- `photo_document_id` UUID NULL
- `hire_date` DATE NOT NULL, `seniority_date` DATE NOT NULL *(pour calcul exact d'ancienneté)*, `termination_date` DATE NULL
- `preferred_attendance_mode` VARCHAR(32) NOT NULL DEFAULT `'QR_OR_PIN'` *(`BIOMETRIC`, `QR_OR_PIN`, `EXEMPT`)*
- `employment_status` VARCHAR(24) NOT NULL *(`DRAFT`, `ACTIVE`, `PROBATION`, `SUSPENDED`, `ON_LEAVE`, `NOTICE_PERIOD`, `TERMINATED`)*
- `created_at`, `updated_at` TIMESTAMPTZ NOT NULL

#### Tables liées à l'agent
- **`employee_dependents`** : `id`, `tenant_id`, `employee_id`, `relationship` (`SPOUSE`, `CHILD`, `LEGAL_WARD`), `full_name`, `birth_date`, `is_student` BOOLEAN, `has_disability` BOOLEAN, `eligible_for_ipr_reduction` BOOLEAN, `eligible_for_family_allowance` BOOLEAN, `effective_from` DATE, `effective_to` DATE, `proof_document_id` UUID, `verified_by`, `verified_at`.
- **`employee_payment_methods`** : `id`, `tenant_id`, `employee_id`, `method_type` (`BANK_TRANSFER`, `MOBILE_MONEY`, `CASH`), `provider_name` (banque ou opérateur), `encrypted_account_details` BYTEA *(numéro de compte/IBAN/téléphone chiffré AES-256-GCM)*, `account_last4` VARCHAR(8), `currency` CHAR(3), `split_type` (`PERCENTAGE`, `FIXED_AMOUNT`, `REMAINDER`), `split_value` NUMERIC(18, 4), `priority_order` SMALLINT, `is_active` BOOLEAN.
- **`employment_contracts`** : `id`, `tenant_id`, `employee_id`, `contract_number`, `contract_type` (`CDI`, `CDD`, `DAILY`, `INTERNSHIP`, `APPRENTICESHIP`, `CONSULTANT`), `start_date` DATE, `end_date` DATE NULL, `probation_end_date` DATE NULL, `renewal_count` SMALLINT DEFAULT 0, `site_id`, `job_position_id`, `job_category_id`, `weekly_hours` NUMERIC(5, 2) NOT NULL DEFAULT 45.00, `base_salary_amount` NUMERIC(18, 4) NOT NULL, `salary_currency` CHAR(3) NOT NULL, `salary_frequency` (`MONTHLY`, `DAILY`, `HOURLY`), `payment_currency_mode` (`CONTRACT_CURRENCY`, `CDF_ONLY`, `SPLIT`), `tax_regime_code` VARCHAR(50) NOT NULL, `housing_mode` (`ALLOWANCE`, `IN_KIND`, `NONE`), `transport_mode` (`ALLOWANCE`, `PROVIDED`, `NONE`), `signed_document_id` UUID, `status` (`DRAFT`, `ACTIVE`, `AMENDED`, `EXPIRED`, `TERMINATED`), `termination_reason` VARCHAR(50), `created_at`, `updated_at`.
- **`contract_amendments`** : `id`, `tenant_id`, `contract_id`, `employee_id`, `amendment_type` (`SALARY_CHANGE`, `PROMOTION`, `SITE_TRANSFER`, `RENEWAL`, `SCHEDULE_CHANGE`, `SUSPENSION`), `effective_date` DATE, `previous_snapshot` JSONB, `new_snapshot` JSONB, `reason` TEXT NOT NULL, `document_id` UUID, `approved_by`, `created_at`.
- **`employee_badges`** : `id`, `tenant_id`, `employee_id`, `badge_serial` VARCHAR(64), `qr_token_id` UUID UNIQUE NOT NULL *(identifiant opaque signé par HMAC/Ed25519 dans le QR Code)*, `qr_token_hash` CHAR(64) UNIQUE NOT NULL, `rfid_card_hash` CHAR(64) NULL, `totp_encrypted_seed` BYTEA NULL *(pour QR dynamique)*, `status` (`ACTIVE`, `REVOKED`, `LOST`, `EXPIRED`), `issued_at`, `expires_at`, `revoked_at`, `revoke_reason`, `issued_by`.
- **`employee_pins`** : `employee_id` UUID PK, `tenant_id` UUID NOT NULL, `pin_hash` TEXT NOT NULL *(Argon2id)*, `failed_attempts` SMALLINT DEFAULT 0, `locked_until` TIMESTAMPTZ, `must_change` BOOLEAN DEFAULT TRUE, `updated_at` TIMESTAMPTZ.
- **`documents`** : `id`, `tenant_id`, `owner_type` (`TENANT`, `EMPLOYEE`, `CONTRACT`, `LEAVE`, `PAYSLIP`, `DECLARATION`, `BIOMETRIC_CONSENT`, `ADJUSTMENT`), `owner_id` UUID, `document_type` VARCHAR(64), `s3_bucket` VARCHAR(128), `s3_key` VARCHAR(512) UNIQUE, `original_filename` VARCHAR(255), `mime_type` VARCHAR(120), `size_bytes` BIGINT, `sha256_checksum` CHAR(64) NOT NULL, `is_immutable` BOOLEAN DEFAULT FALSE, `retention_until` DATE, `expires_at` DATE, `uploaded_by`, `created_at`.

---

### Domaine D4 — Biométrie, Consentements, Terminaux et Synchronisation

- **`biometric_consents`** : `id`, `tenant_id`, `employee_id`, `policy_version` VARCHAR(32) NOT NULL, `allowed_modalities` TEXT[] NOT NULL *(`FINGERPRINT`, `FACE`)*, `consent_status` (`GRANTED`, `WITHDRAWN`, `EXPIRED`), `granted_at` TIMESTAMPTZ NOT NULL, `signed_form_document_id` UUID NOT NULL *(preuve écrite exigée)*, `recorded_by` UUID NOT NULL, `withdrawn_at` TIMESTAMPTZ NULL, `withdrawal_reason` TEXT, `templates_purged_at` TIMESTAMPTZ NULL, `devices_purge_confirmed_at` TIMESTAMPTZ NULL.
- **`biometric_templates`** : `id`, `tenant_id`, `employee_id`, `consent_id` UUID NOT NULL REFERENCES `biometric_consents(id)`, `vendor` VARCHAR(32) NOT NULL *(`ZKTECO`, `HIKVISION`, `ANVIZ`, `SUPREMA`, etc.)*, `modality` VARCHAR(20) NOT NULL *(`FINGERPRINT`, `FACE`)*, `algorithm_version` VARCHAR(40) NOT NULL *(ex. `ZKFINGER_10`, `ZKFINGER_12`, `ZKFACE_VL_58`, `ISO_19794_2`)*, `sub_index` SMALLINT *(index doigt 0–9 ou 0 pour visage)*, `encrypted_template` BYTEA NOT NULL *(AES-256-GCM ; aucune image brute stockée)*, `iv` BYTEA NOT NULL, `auth_tag` BYTEA NOT NULL, `dek_encrypted` BYTEA NOT NULL *(clé de données chiffrée par la clé du tenant)*, `template_sha256` CHAR(64) NOT NULL, `source_device_id` UUID, `enrolled_at` TIMESTAMPTZ NOT NULL, `enrolled_by` UUID NOT NULL.
- **`edge_agents`** : `id`, `tenant_id`, `site_id`, `name`, `agent_version` VARCHAR(32), `credential_hash` CHAR(64), `client_cert_fingerprint` CHAR(64), `status` (`PROVISIONING`, `ONLINE`, `OFFLINE`, `REVOKED`), `last_heartbeat_at` TIMESTAMPTZ, `last_ip` INET, `buffered_events_count` INTEGER DEFAULT 0, `created_at`.
- **`biometric_devices`** : `id`, `tenant_id`, `site_id`, `edge_agent_id` UUID NULL, `name` VARCHAR(120), `vendor` VARCHAR(32) NOT NULL, `model` VARCHAR(80) NOT NULL, `firmware_version` VARCHAR(80), `serial_number` VARCHAR(120) NOT NULL, `connector_code` VARCHAR(64) NOT NULL, `connector_maturity` VARCHAR(32) NOT NULL *(`SIMULATED`, `PROTOCOL_IMPLEMENTED`, `LAB_VALIDATED`, `PRODUCTION_CERTIFIED`)*, `is_simulated` BOOLEAN NOT NULL DEFAULT FALSE, `transport_mode` (`CLOUD_PUSH`, `EDGE_LAN`, `USB_MANUAL`), `capabilities` TEXT[] *(`FINGERPRINT`, `FACE`, `RFID`, `QR`, `PIN`)*, `timezone` VARCHAR(64) NOT NULL, `device_secret_hash` CHAR(64), `allowed_ips` CIDR[], `direction_mode` (`AUTO`, `IN_ONLY`, `OUT_ONLY`, `USER_SELECTED`), `status` (`PENDING_PAIRING`, `ACTIVE`, `MAINTENANCE`, `OFFLINE`, `REVOKED`), `last_heartbeat_at` TIMESTAMPTZ, `last_sync_at` TIMESTAMPTZ, `clock_drift_seconds` INTEGER, `user_count` INTEGER, `template_count` INTEGER, `created_at`, `updated_at` — **UNIQUE `(vendor, serial_number)`**.
- **`kiosk_terminals`** : `id`, `tenant_id`, `site_id`, `name`, `device_token_hash` CHAR(64) UNIQUE, `pairing_code_hash` CHAR(64), `pairing_expires_at` TIMESTAMPTZ, `allowed_modes` TEXT[] (`QR_STATIC`, `QR_DYNAMIC`, `PIN`), `require_pin_with_qr` BOOLEAN DEFAULT FALSE, `require_geofence` BOOLEAN DEFAULT FALSE, `pwa_version` VARCHAR(32), `status` (`PAIRING`, `ACTIVE`, `SUSPENDED`, `REVOKED`), `last_sync_at` TIMESTAMPTZ, `pending_offline_count` INTEGER DEFAULT 0, `created_at`.
- **`device_commands`** : `id`, `tenant_id`, `device_id`, `command_type` (`UPSERT_USER`, `DELETE_USER`, `PUSH_TEMPLATE`, `DELETE_TEMPLATE`, `SYNC_TIME`, `FETCH_LOGS`, `REBOOT`, `INFO`), `target_employee_id` UUID NULL, `payload` JSONB, `priority` SMALLINT DEFAULT 5 *(priorité 1 pour révocation/retrait consentement)*, `status` (`QUEUED`, `DISPATCHED`, `ACK_SUCCESS`, `ACK_FAILED`, `EXPIRED`, `CANCELLED`), `attempt_count` SMALLINT DEFAULT 0, `external_cmd_id` VARCHAR(64), `dispatched_at`, `acknowledged_at`, `error_message` TEXT, `created_by`, `created_at`.
- **`device_sync_logs`** : `id`, `tenant_id`, `device_id`, `direction` (`INBOUND`, `OUTBOUND`), `sync_type`, `records_count` INTEGER, `http_status` SMALLINT, `duration_ms` INTEGER, `source_ip` INET, `error_code` VARCHAR(64), `created_at`.

---

### Domaine D5 — Présences, Horaires, Congés et GTA

#### `attendance_raw_events` *(Table immuable append-only, partitionnée par mois sur `occurred_at_utc`)*
- `id` UUID NOT NULL, `tenant_id` UUID NOT NULL, `site_id` UUID NOT NULL
- `employee_id` UUID NULL *(résolu à partir de `device_user_ref` / `badge_id` ; conservé même si non résolu pour diagnostic)*
- `source_type` VARCHAR(24) NOT NULL *(`BIOMETRIC_DEVICE`, `KIOSK_PWA`, `EDGE_AGENT`, `USB_IMPORT`, `MANUAL_ADJUSTMENT`, `SIMULATOR`)*
- `biometric_device_id` UUID NULL, `kiosk_terminal_id` UUID NULL
- `verification_mode` VARCHAR(24) NOT NULL *(`FINGERPRINT`, `FACE`, `QR_STATIC`, `QR_DYNAMIC`, `PIN`, `QR_AND_PIN`, `RFID`, `MANUAL`)*
- `event_direction` VARCHAR(20) NOT NULL *(`CHECK_IN`, `CHECK_OUT`, `BREAK_START`, `BREAK_END`, `UNSPECIFIED`)*
- `device_user_ref` VARCHAR(64) NOT NULL
- `occurred_at_utc` TIMESTAMPTZ NOT NULL, `device_local_timestamp` TIMESTAMP NOT NULL, `site_timezone` VARCHAR(64) NOT NULL, `received_at_utc` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- `clock_drift_seconds` INTEGER, `was_offline_queued` BOOLEAN NOT NULL DEFAULT FALSE
- `geo_latitude` NUMERIC(9, 6), `geo_longitude` NUMERIC(9, 6), `geofence_valid` BOOLEAN NULL
- `is_simulated` BOOLEAN NOT NULL DEFAULT FALSE
- `idempotency_key` CHAR(64) NOT NULL — **UNIQUE `(tenant_id, idempotency_key, occurred_at_utc)`**
- `processing_status` VARCHAR(24) NOT NULL *(`PENDING`, `PROCESSED`, `DUPLICATE_IGNORED`, `UNMATCHED_EMPLOYEE`, `REJECTED_FRAUD`, `SIMULATION_ONLY`)*
- `raw_payload` JSONB NOT NULL, `event_sha256` CHAR(64) NOT NULL
- PRIMARY KEY `(id, occurred_at_utc)`

#### Tables GTA, horaires et congés
- **`work_schedules`** : `id`, `tenant_id`, `code`, `name`, `schedule_type` (`FIXED_WEEKLY`, `ROTATING_SHIFT`, `FLEXIBLE`, `ROSTER`), `standard_weekly_hours` NUMERIC(5, 2) DEFAULT 45.00, `standard_monthly_days` NUMERIC(5, 2) DEFAULT 26.00, `standard_monthly_hours` NUMERIC(6, 2) DEFAULT 195.00, `late_grace_minutes` SMALLINT DEFAULT 5, `early_leave_grace_minutes` SMALLINT DEFAULT 0, `duplicate_punch_window_seconds` INTEGER DEFAULT 180, `night_window_start` TIME DEFAULT `'19:00'`, `night_window_end` TIME DEFAULT `'05:00'`, `overtime_requires_approval` BOOLEAN DEFAULT TRUE, `is_active` BOOLEAN.
- **`shift_templates`** : `id`, `tenant_id`, `schedule_id`, `code`, `name`, `day_of_week` SMALLINT NULL (1–7), `cycle_day_index` SMALLINT NULL, `is_rest_day` BOOLEAN DEFAULT FALSE, `start_time` TIME, `end_time` TIME, `crosses_midnight` BOOLEAN DEFAULT FALSE, `break_minutes` SMALLINT DEFAULT 60, `is_break_paid` BOOLEAN DEFAULT FALSE, `expected_work_minutes` SMALLINT, `earliest_checkin_offset_min` SMALLINT, `latest_checkout_offset_min` SMALLINT.
- **`employee_shift_assignments`** : `id`, `tenant_id`, `employee_id`, `schedule_id`, `shift_template_id` NULL, `effective_from` DATE NOT NULL, `effective_to` DATE NULL, `assigned_by`, `created_at`.
- **`public_holidays`** : `id`, `tenant_id`, `site_id` NULL *(NULL = tous les sites)*, `holiday_date` DATE NOT NULL, `observed_date` DATE NOT NULL, `name` VARCHAR(160), `is_paid` BOOLEAN DEFAULT TRUE, `legal_reference` VARCHAR(160), `created_at`.
- **`attendance_daily_summaries`** : `id`, `tenant_id`, `employee_id`, `site_id`, `work_date` DATE NOT NULL *(dans le fuseau du site)*, `shift_template_id` UUID NULL, `day_status` (`PRESENT`, `LATE`, `ABSENT_UNJUSTIFIED`, `ABSENT_JUSTIFIED`, `LEAVE`, `HOLIDAY`, `REST_DAY`, `INCOMPLETE_PUNCH`, `MISSION`, `SUSPENDED`), `first_check_in_utc` TIMESTAMPTZ, `last_check_out_utc` TIMESTAMPTZ, `scheduled_minutes` INTEGER DEFAULT 0, `worked_minutes` INTEGER DEFAULT 0, `late_minutes` INTEGER DEFAULT 0, `early_leave_minutes` INTEGER DEFAULT 0, `night_minutes` INTEGER DEFAULT 0, `overtime_raw_minutes` INTEGER DEFAULT 0, `overtime_approved_minutes` INTEGER DEFAULT 0, `eligible_for_transport` BOOLEAN DEFAULT FALSE, `has_manual_adjustment` BOOLEAN DEFAULT FALSE, `is_locked_for_payroll` BOOLEAN DEFAULT FALSE, `payroll_period_id` UUID NULL, `calculated_at` TIMESTAMPTZ — **UNIQUE `(tenant_id, employee_id, work_date)`**.
- **`attendance_adjustments`** : `id`, `tenant_id`, `employee_id`, `daily_summary_id` UUID NULL, `work_date` DATE, `adjustment_type` (`ADD_MISSING_IN`, `ADD_MISSING_OUT`, `OVERRIDE_STATUS`, `EXCUSE_LATE`, `MISSION_DAY`), `proposed_check_in_utc` TIMESTAMPTZ, `proposed_check_out_utc` TIMESTAMPTZ, `reason` TEXT NOT NULL, `proof_document_id` UUID NULL, `requested_by` UUID NOT NULL, `status` (`PENDING`, `APPROVED`, `REJECTED`), `reviewed_by` UUID NULL, `reviewed_at` TIMESTAMPTZ, `review_comment` TEXT, `created_at` *(CHECK `requested_by <> reviewed_by` si SoD activé)*.
- **`overtime_records`** : `id`, `tenant_id`, `employee_id`, `site_id`, `work_date` DATE, `week_start_date` DATE, `minutes` INTEGER, `bucket_code` VARCHAR(40) *(lié à `overtime_rate_rules`, ex. `OT_TIER_1`, `OT_TIER_2`, `OT_REST_OR_HOLIDAY`, `NIGHT_PREMIUM`)*, `status` (`DETECTED`, `APPROVED`, `REJECTED`, `LOCKED`), `approved_by`, `approved_at`, `payroll_period_id` UUID NULL.
- **`leave_types`** : `id`, `tenant_id`, `code`, `name`, `category` (`ANNUAL`, `MATERNITY`, `CIRCUMSTANCE`, `SICK`, `UNPAID`, `COMPENSATORY`, `STUDY`, `OTHER`), `accrual_per_month_days` NUMERIC(6, 3), `seniority_bonus_days` NUMERIC(5, 2), `seniority_step_years` SMALLINT, `max_days_per_event` NUMERIC(5, 2), `pay_ratio` NUMERIC(5, 4) *(ex. `1.0000` plein salaire, `0.6667` maternité, `0.0000` sans solde — paramétrable)*, `requires_document` BOOLEAN, `counts_working_days_only` BOOLEAN DEFAULT TRUE, `is_active` BOOLEAN.
- **`leave_balances`** : `id`, `tenant_id`, `employee_id`, `leave_type_id`, `year` SMALLINT, `opening_balance_days` NUMERIC(7, 2), `accrued_days` NUMERIC(7, 2), `carried_over_days` NUMERIC(7, 2), `taken_days` NUMERIC(7, 2), `pending_days` NUMERIC(7, 2), `adjusted_days` NUMERIC(7, 2), `updated_at` — UNIQUE `(tenant_id, employee_id, leave_type_id, year)`.
- **`leave_requests`** & **`leave_approvals`** : demande avec dates début/fin, demi-journée optionnelle, `total_days`, `reason`, `document_id`, `status` (`DRAFT`, `PENDING_MANAGER`, `PENDING_HR`, `APPROVED`, `REJECTED`, `CANCELLED`), et table d'étapes d'approbation horodatées.
- **`attendance_period_closures`** : `id`, `tenant_id`, `site_id`, `payroll_period_id`, `status` (`OPEN`, `VALIDATED`, `LOCKED`), `anomalies_remaining` INTEGER, `validated_by`, `validated_at`, `summary_snapshot` JSONB.

---

### Domaine D6 — Paie RDC Paramétrable, Devises, Prêts et Bulletins

#### Paramétrage versionné (zéro valeur codée en dur)
- **`currencies`** : `code` CHAR(3) PK (`CDF`, `USD`, `EUR`), `name`, `symbol`, `minor_units` SMALLINT, `rounding_step` NUMERIC(10, 4), `rounding_mode` VARCHAR(20).
- **`exchange_rates`** : `id`, `tenant_id` (NULL = référence plateforme), `base_currency` CHAR(3), `quote_currency` CHAR(3), `rate_type` (`BCC_OFFICIAL`, `PAYROLL_APPLIED`, `BANK_TRANSFER`), `rate` NUMERIC(18, 6) NOT NULL, `effective_date` DATE NOT NULL, `source_reference` VARCHAR(160), `recorded_by`, `created_at` — UNIQUE `(tenant_id, base_currency, quote_currency, rate_type, effective_date)`.
- **`payroll_rule_sets`** : `id`, `tenant_id` (NULL = modèle de référence RDC fourni à valider), `country_code` CHAR(2) DEFAULT `'CD'`, `version_code` VARCHAR(40) NOT NULL, `name` VARCHAR(160), `legal_references` TEXT *(lois de finances, décrets, arrêtés, convention collective)*, `effective_from` DATE NOT NULL, `effective_to` DATE NULL, `status` (`DRAFT`, `VALIDATED`, `ACTIVE`, `SUPERSEDED`), `validated_by` UUID, `validated_at` TIMESTAMPTZ, `created_at`.
- **`smig_schedules`** : `id`, `rule_set_id`, `tenant_id`, `category_code` VARCHAR(32), `daily_amount` NUMERIC(18, 4) NOT NULL, `monthly_amount` NUMERIC(18, 4) NOT NULL, `currency` CHAR(3) NOT NULL DEFAULT `'CDF'`, `decree_reference` VARCHAR(160), `effective_from` DATE, `effective_to` DATE.
- **`payroll_rubrics`** : `id`, `rule_set_id`, `tenant_id`, `code` VARCHAR(40) NOT NULL, `label` VARCHAR(160) NOT NULL, `rubric_kind` (`EARNING`, `BENEFIT_IN_KIND`, `EMPLOYEE_DEDUCTION`, `EMPLOYER_CHARGE`, `NET_ADJUSTMENT`, `INFO`), `calculation_mode` (`FIXED`, `FORMULA`, `RATE_OF_BASE`, `QUANTITY_X_RATE`, `ENGINE_BUILTIN`), `formula_expression` TEXT NULL *(DSL déclaratif sécurisé, sans `eval`)*, `included_in_cnss_base` BOOLEAN NOT NULL, `included_in_inpp_base` BOOLEAN NOT NULL, `included_in_onem_base` BOOLEAN NOT NULL, `included_in_ipr_base` BOOLEAN NOT NULL, `included_in_iere_base` BOOLEAN NOT NULL, `exemption_cap_code` VARCHAR(40) NULL, `prorate_on_attendance` BOOLEAN NOT NULL, `syscohada_debit_account` VARCHAR(20), `syscohada_credit_account` VARCHAR(20), `display_order` SMALLINT, `prints_on_payslip` BOOLEAN DEFAULT TRUE.
- **`payroll_exemption_caps`** : `id`, `rule_set_id`, `tenant_id`, `cap_code` VARCHAR(40) *(ex. `HOUSING_RATIO_CAP`, `TRANSPORT_DAILY_CAP`, `LEGAL_FAMILY_ALLOWANCE`)*, `cap_type` (`RATIO_OF_BASE`, `FIXED_DAILY_PER_ZONE_MODE`, `FIXED_MONTHLY_PER_DEPENDENT`, `FIXED_MONTHLY`), `zone_code` VARCHAR(40) NULL, `transport_mode` VARCHAR(24) NULL, `cap_value` NUMERIC(18, 6) NOT NULL, `currency` CHAR(3) NULL, `excess_treatment` (`TAXABLE_AND_CONTRIBUTABLE`, `TAXABLE_ONLY`, `REJECT`), `legal_reference` VARCHAR(160).
- **`payroll_contribution_rules`** : `id`, `rule_set_id`, `tenant_id`, `organism_code` VARCHAR(32) *(`CNSS`, `INPP`, `ONEM`, `UNION`, `MUTUAL`, etc.)*, `branch_code` VARCHAR(40) *(`PENSION_EMP`, `PENSION_ER`, `OCCUPATIONAL_RISK_ER`, `FAMILY_BENEFIT_ER`, `INPP_ER`, `ONEM_ER`)*, `label` VARCHAR(160), `payer` (`EMPLOYEE`, `EMPLOYER`), `rate` NUMERIC(10, 6) NOT NULL, `headcount_min` INTEGER NULL, `headcount_max` INTEGER NULL, `applicable_legal_forms` TEXT[] NULL, `base_floor_amount` NUMERIC(18, 4) NULL, `base_ceiling_amount` NUMERIC(18, 4) NULL, `base_currency` CHAR(3) NOT NULL DEFAULT `'CDF'`, `deductible_from_ipr` BOOLEAN NOT NULL DEFAULT FALSE, `legal_reference` VARCHAR(160).
- **`payroll_tax_regimes`** : `id`, `rule_set_id`, `tenant_id`, `regime_code` VARCHAR(50) *(`IPR_STANDARD`, `IPR_OCCASIONAL`, `IPR_FINAL_SETTLEMENT`, `IERE_GENERAL`, `IERE_MINING`, `EXEMPT_DIPLOMATIC_NGO`, etc.)*, `tax_type` (`PROGRESSIVE_BRACKETS`, `FLAT_RATE`), `payer` (`EMPLOYEE`, `EMPLOYER`), `flat_rate` NUMERIC(10, 6) NULL, `calculation_currency` CHAR(3) NOT NULL DEFAULT `'CDF'`, `periodicity` (`ANNUAL_DIV_12`, `MONTHLY`), `max_effective_rate` NUMERIC(10, 6) NULL *(plafonnement global paramétrable)*, `minimum_monthly_tax` NUMERIC(18, 4) NULL *(impôt minimum paramétrable)*, `dependent_reduction_rate` NUMERIC(10, 6) NULL, `max_dependents_count` SMALLINT NULL, `dependent_reduction_max_bracket_order` SMALLINT NULL, `legal_reference` VARCHAR(160).
- **`payroll_tax_brackets`** : `id`, `tax_regime_id`, `tenant_id`, `bracket_order` SMALLINT NOT NULL, `min_amount` NUMERIC(18, 4) NOT NULL, `max_amount` NUMERIC(18, 4) NULL *(NULL = tranche supérieure ouverte)*, `rate` NUMERIC(10, 6) NOT NULL — UNIQUE `(tax_regime_id, bracket_order)`.
- **`overtime_rate_rules`** : `id`, `rule_set_id`, `tenant_id`, `bucket_code` VARCHAR(40), `label`, `day_condition` (`WEEKDAY`, `REST_DAY`, `PUBLIC_HOLIDAY`, `NIGHT`), `weekly_ot_min_hours` NUMERIC(5, 2), `weekly_ot_max_hours` NUMERIC(5, 2), `multiplier` NUMERIC(8, 4) NOT NULL *(paramétrable)*, `priority_order` SMALLINT.
- **`garnishment_rules`** : `id`, `rule_set_id`, `tenant_id`, `tier_order` SMALLINT, `threshold_multiplier` NUMERIC(10, 4), `max_attachable_ratio` NUMERIC(8, 4), `alimony_max_ratio` NUMERIC(8, 4), `legal_reference` VARCHAR(160).

#### Éléments individuels, avances, prêts et exécution de la paie
- **`employee_recurring_items`** : `id`, `tenant_id`, `employee_id`, `rubric_code`, `amount_or_rate` NUMERIC(18, 4), `currency` CHAR(3), `effective_from` DATE, `effective_to` DATE, `notes`.
- **`salary_advances`** : `id`, `tenant_id`, `employee_id`, `advance_type` (`FORTNIGHT_ACOMPTE`, `EXCEPTIONAL_ADVANCE`), `amount` NUMERIC(18, 4), `currency` CHAR(3), `requested_at`, `approved_by`, `paid_at`, `target_payroll_period_id` UUID, `status` (`PENDING`, `APPROVED`, `PAID`, `DEDUCTED`, `CANCELLED`).
- **`employee_loans`** & **`loan_installments`** : prêts internes ou oppositions/saisies-arrêts (`INTERNAL_LOAN`, `COURT_GARNISHMENT`, `ALIMONY`), capital, devise, nombre d'échéances, taux d'intérêt éventuel (souvent 0 %), document justificatif, et échéancier mensuel rattaché aux bulletins.
- **`payroll_periods`** : `id`, `tenant_id`, `year` SMALLINT, `month` SMALLINT (1–12), `code` (`2026-11`), `start_date` DATE, `end_date` DATE, `payment_date` DATE, `declaration_due_date` DATE, `status` (`OPEN`, `IN_PROGRESS`, `APPROVED`, `LOCKED`), UNIQUE `(tenant_id, year, month)`.
- **`payroll_runs`** : `id`, `tenant_id`, `payroll_period_id`, `site_id` NULL *(NULL = toute l'entreprise)*, `run_number` INTEGER, `run_type` (`REGULAR`, `SUPPLEMENTARY`, `RETROACTIVE`, `FINAL_SETTLEMENT`), `rule_set_id` UUID NOT NULL, `frozen_rule_set_snapshot` JSONB NOT NULL *(copie immuable intégrale de toutes les règles et tranches utilisées)*, `frozen_exchange_rates` JSONB NOT NULL, `declared_headcount` INTEGER NOT NULL *(pour la tranche INPP)*, `status` (`DRAFT`, `CALCULATING`, `CALCULATED`, `REVIEWED`, `APPROVED`, `LOCKED`, `SUPERSEDED`), `employees_count` INTEGER, `total_gross_cdf` NUMERIC(18, 4), `total_net_cdf` NUMERIC(18, 4), `total_employee_cnss_cdf` NUMERIC(18, 4), `total_employer_charges_cdf` NUMERIC(18, 4), `total_ipr_cdf` NUMERIC(18, 4), `total_iere_cdf` NUMERIC(18, 4), `calculated_by`, `calculated_at`, `reviewed_by`, `reviewed_at`, `approved_by`, `approved_at`, `locked_by`, `locked_at`, `ledger_sha256` CHAR(64) *(CHECK `calculated_by <> approved_by` si SoD activé)*.
- **`payroll_payslips`** : `id`, `tenant_id`, `payroll_run_id`, `payroll_period_id`, `employee_id`, `contract_id`, `site_id`, `employee_snapshot` JSONB NOT NULL *(nom, matricule, poste, catégorie, CNSS, personnes à charge, compte masqué à la date de paie)*, `attendance_snapshot` JSONB NOT NULL *(jours ouvrés, jours prestés, congés, absences, heures sup., heures nuit)*, `contract_currency` CHAR(3), `applied_fx_rate_to_cdf` NUMERIC(18, 6), `gross_cdf` NUMERIC(18, 4), `taxable_gross_cdf` NUMERIC(18, 4), `cnss_base_cdf` NUMERIC(18, 4), `cnss_employee_cdf` NUMERIC(18, 4), `cnss_employer_cdf` NUMERIC(18, 4), `inpp_employer_cdf` NUMERIC(18, 4), `onem_employer_cdf` NUMERIC(18, 4), `net_taxable_ipr_cdf` NUMERIC(18, 4), `ipr_cdf` NUMERIC(18, 4), `iere_employer_cdf` NUMERIC(18, 4), `other_deductions_cdf` NUMERIC(18, 4), `net_payable_cdf` NUMERIC(18, 4), `net_payable_contract_currency` NUMERIC(18, 4), `payment_breakdown` JSONB, `calculation_trace` JSONB NOT NULL, `pdf_document_id` UUID NULL, `verification_hash` CHAR(64) NOT NULL, `published_to_employee_at` TIMESTAMPTZ, `status` (`DRAFT`, `FINALIZED`, `LOCKED`).
- **`payroll_payslip_lines`** : `id`, `tenant_id`, `payslip_id`, `line_order` SMALLINT, `rubric_code` VARCHAR(40), `label` VARCHAR(160), `rubric_kind` VARCHAR(32), `quantity` NUMERIC(12, 4), `unit_rate` NUMERIC(18, 4), `base_amount_cdf` NUMERIC(18, 4), `rate` NUMERIC(12, 6), `employee_gain_cdf` NUMERIC(18, 4), `employee_deduction_cdf` NUMERIC(18, 4), `employer_charge_cdf` NUMERIC(18, 4), `amount_contract_currency` NUMERIC(18, 4), `formula_note` TEXT.
- **`final_settlements`** : `id`, `tenant_id`, `employee_id`, `contract_id`, `payroll_run_id` UUID NULL, `termination_type`, `termination_date` DATE, `seniority_years` NUMERIC(6, 2), `notice_days_due` NUMERIC(6, 2), `unused_leave_days` NUMERIC(7, 2), `severance_days` NUMERIC(7, 2), `outstanding_loans_cdf` NUMERIC(18, 4), `breakdown_snapshot` JSONB, `status` (`DRAFT`, `APPROVED`, `LOCKED`, `PAID`), `document_id` UUID, `created_at`.

---

### Domaine D7 — Audit Immuable, Outbox, Notifications et Webhooks

#### `audit_logs` *(Append-only, chaînée par tenant, partitionnée par trimestre)*
- `id` UUID NOT NULL, `seq_no` BIGSERIAL, `tenant_id` UUID NULL *(NULL pour actions plateforme)*
- `actor_type` VARCHAR(20) NOT NULL *(`USER`, `SYSTEM`, `API_KEY`, `DEVICE`, `SUPERADMIN`)*
- `actor_id` UUID NULL, `actor_role` VARCHAR(64), `ip_address` INET, `user_agent` TEXT, `request_id` UUID
- `action` VARCHAR(100) NOT NULL *(ex. `PAYROLL_RUN_LOCKED`, `BIOMETRIC_CONSENT_WITHDRAWN`, `SALARY_UPDATED`, `RULE_SET_MODIFIED`)*
- `resource_type` VARCHAR(64) NOT NULL, `resource_id` UUID NULL, `site_id` UUID NULL
- `reason` TEXT NULL, `before_state` JSONB NULL, `after_state` JSONB NULL *(champs secrets et gabarits systématiquement expurgés)*
- `prev_hash` CHAR(64) NOT NULL, `entry_hash` CHAR(64) NOT NULL *(`SHA256(prev_hash || canonical_payload)`)*
- `occurred_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()

#### Autres tables techniques
- **`outbox_events`** : `id`, `tenant_id`, `exchange` VARCHAR(80), `routing_key` VARCHAR(120), `payload` JSONB, `headers` JSONB, `status` (`PENDING`, `PUBLISHED`, `FAILED`), `attempt_count` SMALLINT, `next_attempt_at` TIMESTAMPTZ, `published_at` TIMESTAMPTZ, `created_at`.
- **`notifications`** : `id`, `tenant_id`, `recipient_user_id`, `channel` (`IN_APP`, `EMAIL`, `SMS`), `category`, `title`, `body`, `link_url`, `read_at`, `sent_at`, `created_at`.
- **`webhook_endpoints`** & **`webhook_deliveries`** : URL HTTPS cible, `encrypted_signing_secret`, événements souscrits (`attendance.daily.validated`, `payroll.run.locked`, `employee.created`), journal des livraisons, codes HTTP et tentatives.

---

## 4. Index stratégiques et politiques RLS

### 4.1 Exemples d'index critiques

- `idx_employees_tenant_site_status` ON `employees (tenant_id, primary_site_id, employment_status)`
- `idx_raw_events_tenant_emp_time` ON `attendance_raw_events (tenant_id, employee_id, occurred_at_utc DESC)`
- `idx_raw_events_tenant_status` ON `attendance_raw_events (tenant_id, processing_status)` WHERE `processing_status = 'PENDING'`
- `idx_daily_summary_tenant_site_date` ON `attendance_daily_summaries (tenant_id, site_id, work_date, day_status)`
- `idx_device_cmd_queue` ON `device_commands (device_id, priority ASC, created_at ASC)` WHERE `status = 'QUEUED'`
- `idx_payslips_tenant_period_site` ON `payroll_payslips (tenant_id, payroll_period_id, site_id)`
- `idx_payslips_tenant_employee` ON `payroll_payslips (tenant_id, employee_id, payroll_period_id DESC)`
- `idx_audit_tenant_time` ON `audit_logs (tenant_id, occurred_at DESC)`

### 4.2 Modèle standard de politique PostgreSQL RLS

```sql
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_employees ON employees
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```

Le rôle PostgreSQL utilisé par l'application (`nexus_app`) **ne possède jamais** les privilèges `SUPERUSER` ni `BYPASSRLS`. Seul le rôle de migration CI/CD (`nexus_migrator`) détient les droits DDL.
