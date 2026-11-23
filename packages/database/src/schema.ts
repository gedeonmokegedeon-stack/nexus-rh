import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Schéma Drizzle ORM de NEXUS RH — Missions 1 & 2 + Vague 1 (18 tables FORCE RLS),
 * strictement aligné sur les migrations SQL versionnées 0001, 0002 et 0003
 * (colonnes, clés étrangères, index composites et index uniques partiels).
 */

export const subscriptionPlans = pgTable('subscription_plans', {
  id: uuid('id').primaryKey(),
  code: varchar('code', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  maxActiveEmployees: integer('max_active_employees').notNull(),
  maxSites: integer('max_sites').notNull(),
  maxBiometricDevices: integer('max_biometric_devices').notNull(),
  storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' }).notNull(),
  enabledModules: jsonb('enabled_modules').$type<string[]>().notNull().default([]),
  basePrice: numeric('base_price', { precision: 18, scale: 4 }),
  pricePerEmployee: numeric('price_per_employee', { precision: 18, scale: 4 }),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  legalName: varchar('legal_name', { length: 255 }).notNull(),
  tradeName: varchar('trade_name', { length: 255 }),
  legalForm: varchar('legal_form', { length: 50 }).notNull(),
  countryCode: char('country_code', { length: 2 }).notNull().default('CD'),
  sectorCode: varchar('sector_code', { length: 50 }).notNull().default('GENERAL'),
  rccm: varchar('rccm', { length: 100 }),
  idNat: varchar('id_nat', { length: 100 }),
  taxIdDgi: varchar('tax_id_dgi', { length: 100 }),
  cnssEmployerNumber: varchar('cnss_employer_number', { length: 100 }),
  inppEmployerNumber: varchar('inpp_employer_number', { length: 100 }),
  onemEmployerNumber: varchar('onem_employer_number', { length: 100 }),
  defaultCurrency: char('default_currency', { length: 3 }).notNull().default('CDF'),
  matriculePattern: varchar('matricule_pattern', { length: 120 })
    .notNull()
    .default('{SITE}-{YYYY}-{SEQ:5}'),
  encryptionKeyRef: varchar('encryption_key_ref', { length: 255 }).notNull(),
  biometricStoragePolicy: varchar('biometric_storage_policy', { length: 24 })
    .notNull()
    .default('DEVICE_ONLY'),
  centralTemplateStorageEnabled: boolean('central_template_storage_enabled')
    .notNull()
    .default(false),
  biometricLegalAuthorizationRef: varchar('biometric_legal_authorization_ref', { length: 160 }),
  biometricPolicyApprovedBy: uuid('biometric_policy_approved_by').references(() => users.id),
  biometricPolicyApprovedAt: timestamp('biometric_policy_approved_at', { withTimezone: true }),
  status: varchar('status', { length: 24 }).notNull().default('ACTIVE'),
  isDemoTenant: boolean('is_demo_tenant').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenantSubscriptions = pgTable('tenant_subscriptions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  planId: uuid('plan_id')
    .notNull()
    .references(() => subscriptionPlans.id),
  status: varchar('status', { length: 24 }).notNull().default('TRIAL'),
  billingCycle: varchar('billing_cycle', { length: 16 }).notNull().default('MONTHLY'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  customOverrides: jsonb('custom_overrides').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    siteType: varchar('site_type', { length: 40 }).notNull().default('BRANCH'),
    province: varchar('province', { length: 80 }).notNull(),
    city: varchar('city', { length: 100 }).notNull(),
    commune: varchar('commune', { length: 100 }),
    addressLine: text('address_line'),
    timezone: varchar('timezone', { length: 64 }).notNull(),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    geofenceRadiusMeters: integer('geofence_radius_meters'),
    transportZoneCode: varchar('transport_zone_code', { length: 40 }),
    isHeadquarters: boolean('is_headquarters').notNull().default(false),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_sites_tenant_code').on(t.tenantId, t.code),
    index('idx_sites_tenant_status').on(t.tenantId, t.status),
  ],
);

export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    siteId: uuid('site_id'),
    parentDepartmentId: uuid('parent_department_id'),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_departments_tenant_code').on(t.tenantId, t.code),
    index('idx_departments_tenant_site').on(t.tenantId, t.siteId),
  ],
);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  phone: varchar('phone', { length: 32 }),
  passwordHash: text('password_hash').notNull(),
  fullName: varchar('full_name', { length: 160 }).notNull(),
  isPlatformSuperadmin: boolean('is_platform_superadmin').notNull().default(false),
  mfaRequired: boolean('mfa_required').notNull().default(false),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  failedLoginCount: smallint('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mfaFactors = pgTable(
  'mfa_factors',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    factorType: varchar('factor_type', { length: 24 }).notNull(),
    encryptedPayload: jsonb('encrypted_payload').notNull(),
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_mfa_user_type').on(t.userId, t.factorType)],
);

export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activeTenantId: uuid('active_tenant_id').references(() => tenants.id),
    refreshTokenHash: char('refresh_token_hash', { length: 64 }).notNull().unique(),
    tokenFamilyId: uuid('token_family_id').notNull(),
    mfaVerified: boolean('mfa_verified').notNull().default(false),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: varchar('user_agent', { length: 512 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: varchar('revoke_reason', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_sessions_user_active').on(t.userId, t.revokedAt, t.expiresAt),
    index('idx_sessions_family').on(t.tokenFamilyId),
  ],
);

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey(),
  code: varchar('code', { length: 80 }).notNull().unique(),
  module: varchar('module', { length: 40 }).notNull(),
  description: text('description').notNull(),
  isSensitive: boolean('is_sensitive').notNull().default(false),
});

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    code: varchar('code', { length: 48 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_roles_system_code')
      .on(t.code)
      .where(sql`${t.tenantId} IS NULL`),
    uniqueIndex('uq_roles_tenant_code')
      .on(t.tenantId, t.code)
      .where(sql`${t.tenantId} IS NOT NULL`),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    scopeType: varchar('scope_type', { length: 24 }).notNull().default('ALL_SITES'),
    mfaRequired: boolean('mfa_required').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    supportJustification: varchar('support_justification', { length: 500 }),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    createdBy: uuid('created_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    revokeReason: varchar('revoke_reason', { length: 300 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_membership_tenant_user_role_active')
      .on(t.tenantId, t.userId, t.roleId)
      .where(sql`${t.status} IN ('ACTIVE', 'SUSPENDED')`),
    index('idx_memberships_tenant_user').on(t.tenantId, t.userId, t.status),
    index('idx_memberships_tenant_user_active_expiry')
      .on(t.tenantId, t.userId, t.expiresAt)
      .where(sql`${t.status} = 'ACTIVE'`),
    index('idx_memberships_user_status').on(t.userId, t.status),
  ],
);

export const membershipSiteScopes = pgTable(
  'membership_site_scopes',
  {
    membershipId: uuid('membership_id').notNull(),
    siteId: uuid('site_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.siteId] })],
);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: varchar('name', { length: 120 }).notNull(),
  keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
  keyHash: char('key_hash', { length: 64 }).notNull().unique(),
  scopes: text('scopes').array().notNull().default([]),
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(60),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    exchange: varchar('exchange', { length: 80 }).notNull(),
    routingKey: varchar('routing_key', { length: 120 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
    status: varchar('status', { length: 20 }).notNull().default('PENDING'),
    attemptCount: smallint('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_outbox_pending')
      .on(t.tenantId, t.status, t.nextAttemptAt)
      .where(sql`${t.status} = 'PENDING'`),
    index('idx_outbox_tenant_retryable')
      .on(t.tenantId, t.status, t.nextAttemptAt)
      .where(sql`${t.status} IN ('PENDING', 'FAILED')`),
    index('idx_outbox_global_retryable')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} IN ('PENDING', 'FAILED')`),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    seqNo: bigserial('seq_no', { mode: 'number' }).notNull().unique(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    chainScope: varchar('chain_scope', { length: 64 }).notNull(),
    actorType: varchar('actor_type', { length: 20 }).notNull(),
    actorId: uuid('actor_id'),
    actorEmail: varchar('actor_email', { length: 255 }),
    actorRole: varchar('actor_role', { length: 64 }),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: varchar('user_agent', { length: 512 }),
    requestId: varchar('request_id', { length: 64 }),
    action: varchar('action', { length: 100 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: varchar('resource_id', { length: 128 }),
    siteId: uuid('site_id'),
    reason: text('reason'),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    prevHash: char('prev_hash', { length: 64 }).notNull(),
    entryHash: char('entry_hash', { length: 64 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_audit_chain_scope_seq').on(t.chainScope, t.seqNo),
    index('idx_audit_tenant_occurred').on(t.tenantId, t.occurredAt),
  ],
);

// ============================================================================
// Mission 2 — Cœur RH RDC (8 tables sous FORCE ROW LEVEL SECURITY)
// ============================================================================

export const jobPositions = pgTable(
  'job_positions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    departmentId: uuid('department_id'),
    code: varchar('code', { length: 32 }).notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    professionalCategory: varchar('professional_category', { length: 40 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_job_positions_tenant_code').on(t.tenantId, t.code),
    index('idx_job_positions_tenant_dept').on(t.tenantId, t.departmentId, t.status),
  ],
);

export const matriculeCounters = pgTable(
  'matricule_counters',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    scopeKey: varchar('scope_key', { length: 96 }).notNull(),
    lastValue: bigint('last_value', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.scopeKey] })],
);

export const employees = pgTable(
  'employees',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    matricule: varchar('matricule', { length: 80 }).notNull(),
    primarySiteId: uuid('primary_site_id').notNull(),
    departmentId: uuid('department_id'),
    jobPositionId: uuid('job_position_id'),
    managerEmployeeId: uuid('manager_employee_id'),
    userId: uuid('user_id').references(() => users.id),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    postName: varchar('post_name', { length: 100 }),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    gender: char('gender', { length: 1 }).notNull(),
    birthDate: date('birth_date', { mode: 'string' }).notNull(),
    birthPlace: varchar('birth_place', { length: 120 }),
    nationalityCode: char('nationality_code', { length: 2 }).notNull().default('CD'),
    isExpatriate: boolean('is_expatriate'),
    maritalStatus: varchar('marital_status', { length: 24 }).notNull().default('SINGLE'),
    taxDependentsCount: smallint('tax_dependents_count').notNull().default(0),
    hireDate: date('hire_date', { mode: 'string' }).notNull(),
    terminationDate: date('termination_date', { mode: 'string' }),
    terminationReason: text('termination_reason'),
    workEmail: varchar('work_email', { length: 255 }),
    phonePrimary: varchar('phone_primary', { length: 32 }),
    province: varchar('province', { length: 80 }),
    city: varchar('city', { length: 100 }),
    commune: varchar('commune', { length: 100 }),
    addressLine: text('address_line'),
    emergencyContactName: varchar('emergency_contact_name', { length: 160 }),
    emergencyContactPhone: varchar('emergency_contact_phone', { length: 32 }),
    identityDocType: varchar('identity_doc_type', { length: 32 }),
    identityDocMasked: varchar('identity_doc_masked', { length: 32 }),
    identityDocExpiresAt: date('identity_doc_expires_at', { mode: 'string' }),
    cnssNumberMasked: varchar('cnss_number_masked', { length: 32 }),
    individualTaxIdMasked: varchar('individual_tax_id_masked', { length: 32 }),
    encryptedPii: jsonb('encrypted_pii'),
    cnssBlindIndex: char('cnss_blind_index', { length: 64 }),
    identityDocBlindIndex: char('identity_doc_blind_index', { length: 64 }),
    paymentMethod: varchar('payment_method', { length: 24 }).notNull().default('BANK_TRANSFER'),
    bankName: varchar('bank_name', { length: 120 }),
    bankAccountMasked: varchar('bank_account_masked', { length: 32 }),
    mobileMoneyOperator: varchar('mobile_money_operator', { length: 24 }),
    mobileMoneyMasked: varchar('mobile_money_masked', { length: 32 }),
    encryptedPayment: jsonb('encrypted_payment'),
    attendanceMode: varchar('attendance_mode', { length: 24 }).notNull().default('QR_PIN_ONLY'),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_employees_tenant_matricule').on(t.tenantId, t.matricule),
    uniqueIndex('uq_employees_tenant_cnss_blind')
      .on(t.tenantId, t.cnssBlindIndex)
      .where(sql`${t.cnssBlindIndex} IS NOT NULL`),
    uniqueIndex('uq_employees_tenant_iddoc_blind')
      .on(t.tenantId, t.identityDocBlindIndex)
      .where(sql`${t.identityDocBlindIndex} IS NOT NULL`),
    uniqueIndex('uq_employees_tenant_user')
      .on(t.tenantId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    index('idx_employees_tenant_site_status').on(t.tenantId, t.primarySiteId, t.status),
    index('idx_employees_tenant_name').on(t.tenantId, t.lastName, t.postName, t.firstName),
    index('idx_employees_tenant_iddoc_expiry')
      .on(t.tenantId, t.identityDocExpiresAt)
      .where(sql`${t.identityDocExpiresAt} IS NOT NULL`),
  ],
);

export const employeeDependents = pgTable(
  'employee_dependents',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    fullName: varchar('full_name', { length: 160 }).notNull(),
    relationship: varchar('relationship', { length: 24 }).notNull(),
    birthDate: date('birth_date', { mode: 'string' }),
    isTaxDependent: boolean('is_tax_dependent').notNull().default(true),
    isPfBeneficiary: boolean('is_pf_beneficiary').notNull().default(true),
    notes: varchar('notes', { length: 400 }),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_dependents_tenant_employee').on(t.tenantId, t.employeeId, t.status)],
);

export const employeeDocuments = pgTable(
  'employee_documents',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    category: varchar('category', { length: 32 }).notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    originalFilename: varchar('original_filename', { length: 200 }).notNull(),
    mimeType: varchar('mime_type', { length: 80 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256Checksum: char('sha256_checksum', { length: 64 }).notNull(),
    storageBucket: varchar('storage_bucket', { length: 120 }).notNull(),
    objectKey: varchar('object_key', { length: 512 }).notNull().unique(),
    isEnvelopeEncrypted: boolean('is_envelope_encrypted').notNull().default(true),
    expiresAt: date('expires_at', { mode: 'string' }),
    retentionUntil: date('retention_until', { mode: 'string' }),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    deletedBy: uuid('deleted_by').references(() => users.id),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deleteReason: varchar('delete_reason', { length: 400 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_documents_tenant_employee').on(t.tenantId, t.employeeId, t.status),
    index('idx_documents_tenant_expiry')
      .on(t.tenantId, t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL AND ${t.status} = 'ACTIVE'`),
  ],
);

export const employmentContracts = pgTable(
  'employment_contracts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    siteId: uuid('site_id').notNull(),
    jobPositionId: uuid('job_position_id'),
    contractNumber: varchar('contract_number', { length: 64 }).notNull(),
    contractType: varchar('contract_type', { length: 24 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    probationEndDate: date('probation_end_date', { mode: 'string' }),
    cddRenewalCount: smallint('cdd_renewal_count').notNull().default(0),
    weeklyHours: numeric('weekly_hours', { precision: 5, scale: 2 }).notNull().default('45.00'),
    payCurrency: char('pay_currency', { length: 3 }).notNull(),
    payFrequency: varchar('pay_frequency', { length: 16 }).notNull().default('MONTHLY'),
    encryptedBaseSalary: jsonb('encrypted_base_salary').notNull(),
    hiringPlace: varchar('hiring_place', { length: 120 }).notNull(),
    onemVisaRef: varchar('onem_visa_ref', { length: 80 }),
    onemVisaDate: date('onem_visa_date', { mode: 'string' }),
    signedDocumentId: uuid('signed_document_id'),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    statusReason: varchar('status_reason', { length: 500 }),
    terminatedAt: timestamp('terminated_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_contracts_tenant_number').on(t.tenantId, t.contractNumber),
    uniqueIndex('uq_contracts_one_active_per_employee')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.status} = 'ACTIVE'`),
    index('idx_contracts_tenant_employee').on(t.tenantId, t.employeeId, t.status),
    index('idx_contracts_tenant_site').on(t.tenantId, t.siteId, t.status),
  ],
);

export const employeeAttendanceBadges = pgTable(
  'employee_attendance_badges',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    siteId: uuid('site_id').notNull(),
    badgeCode: varchar('badge_code', { length: 48 }).notNull(),
    qrTokenHash: char('qr_token_hash', { length: 64 }).notNull().unique(),
    pinArgon2Hash: text('pin_argon2_hash').notNull(),
    failedPinAttempts: smallint('failed_pin_attempts').notNull().default(0),
    pinLockedUntil: timestamp('pin_locked_until', { withTimezone: true }),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    issuedBy: uuid('issued_by')
      .notNull()
      .references(() => users.id),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: date('expires_at', { mode: 'string' }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: varchar('revoke_reason', { length: 300 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_badges_tenant_code').on(t.tenantId, t.badgeCode),
    uniqueIndex('uq_badges_one_active_per_employee')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.status} = 'ACTIVE'`),
    index('idx_badges_tenant_employee').on(t.tenantId, t.employeeId, t.status),
  ],
);

export const employeeConsents = pgTable(
  'employee_consents',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    consentType: varchar('consent_type', { length: 40 }).notNull(),
    decision: varchar('decision', { length: 16 }).notNull(),
    policyVersion: varchar('policy_version', { length: 40 }).notNull(),
    collectionMethod: varchar('collection_method', { length: 32 }).notNull(),
    noticeSummary: text('notice_summary').notNull(),
    alternativeQrPinOffered: boolean('alternative_qr_pin_offered').notNull(),
    signedDocumentId: uuid('signed_document_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawalReason: varchar('withdrawal_reason', { length: 500 }),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id),
    withdrawnBy: uuid('withdrawn_by').references(() => users.id),
    ipAddress: varchar('ip_address', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_consents_one_granted_per_type')
      .on(t.tenantId, t.employeeId, t.consentType)
      .where(sql`${t.decision} = 'GRANTED'`),
    index('idx_consents_tenant_employee_type').on(
      t.tenantId,
      t.employeeId,
      t.consentType,
      t.decidedAt,
    ),
  ],
);
