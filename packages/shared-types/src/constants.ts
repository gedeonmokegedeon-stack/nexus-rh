/**
 * Référentiels géographiques et organisationnels de la République Démocratique du Congo.
 * Aucun taux fiscal, social ou monétaire n'est défini dans le code source : tous les
 * paramètres de paie sont exclusivement stockés et versionnés en base de données.
 */

export const DRC_TIMEZONES = ['Africa/Kinshasa', 'Africa/Lubumbashi'] as const;
export type DrcTimezone = (typeof DRC_TIMEZONES)[number];

export interface DrcProvinceInfo {
  readonly code: string;
  readonly name: string;
  readonly defaultTimezone: DrcTimezone;
  readonly utcOffsetLabel: 'UTC+1 (WAT)' | 'UTC+2 (CAT)';
}

/**
 * Les 26 provinces constitutionnelles de la RDC avec leur fuseau horaire officiel.
 */
export const DRC_PROVINCES: readonly DrcProvinceInfo[] = [
  // Zone Ouest — Africa/Kinshasa (UTC+1 / WAT)
  { code: 'KN', name: 'Kinshasa', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  { code: 'BC', name: 'Kongo Central', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  { code: 'KG', name: 'Kwango', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  { code: 'KL', name: 'Kwilu', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  { code: 'MN', name: 'Maï-Ndombe', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  { code: 'EQ', name: 'Équateur', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  { code: 'MO', name: 'Mongala', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  { code: 'NU', name: 'Nord-Ubangi', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  { code: 'SU', name: 'Sud-Ubangi', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  { code: 'TU', name: 'Tshuapa', defaultTimezone: 'Africa/Kinshasa', utcOffsetLabel: 'UTC+1 (WAT)' },
  // Zone Est, Centre et Sud — Africa/Lubumbashi (UTC+2 / CAT)
  { code: 'HK', name: 'Haut-Katanga', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'LU', name: 'Lualaba', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'HL', name: 'Haut-Lomami', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'TA', name: 'Tanganyika', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'NK', name: 'Nord-Kivu', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'SK', name: 'Sud-Kivu', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'IT', name: 'Ituri', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'MA', name: 'Maniema', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'TO', name: 'Tshopo', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'BU', name: 'Bas-Uele', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'HU', name: 'Haut-Uele', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'KS', name: 'Kasaï', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'KC', name: 'Kasaï-Central', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'KE', name: 'Kasaï-Oriental', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'LO', name: 'Lomami', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
  { code: 'SA', name: 'Sankuru', defaultTimezone: 'Africa/Lubumbashi', utcOffsetLabel: 'UTC+2 (CAT)' },
] as const;

export const LEGAL_FORMS = [
  'SARL',
  'SA',
  'SAS',
  'SNC',
  'SCS',
  'ETS',
  'COOPERATIVE',
  'ASBL',
  'ONG',
  'PUBLIC_ENT',
  'OTHER',
] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

export const SECTOR_CODES = [
  'GENERAL',
  'MINING',
  'BANKING_FINANCE',
  'TELECOM',
  'INDUSTRY',
  'AGRO_INDUSTRY',
  'CONSTRUCTION',
  'LOGISTICS',
  'HEALTH',
  'EDUCATION',
  'SECURITY_GUARDING',
  'HOSPITALITY',
  'RETAIL',
  'NGO_HUMANITARIAN',
  'ACCOUNTING_FIRM',
  'PUBLIC_SECTOR',
  'OTHER',
] as const;
export type SectorCode = (typeof SECTOR_CODES)[number];

export const SUPPORTED_CURRENCIES = ['CDF', 'USD', 'EUR'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const TENANT_STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const SITE_TYPES = [
  'HEADQUARTERS',
  'BRANCH',
  'PLANT',
  'WAREHOUSE',
  'MINE_SITE',
  'WORKSITE',
  'CLINIC',
  'CAMPUS',
  'AGENCY',
  'OTHER',
] as const;
export type SiteType = (typeof SITE_TYPES)[number];

/**
 * Politique de stockage des données biométriques (Décision propriétaire n° 6) :
 * - DEVICE_ONLY (défaut obligatoire) : les gabarits restent uniquement sur les terminaux locaux.
 * - ENCRYPTED_CENTRAL_SYNC : interdit sans autorisation juridique référencée, consentement écrit et validation explicite.
 */
export const BIOMETRIC_STORAGE_POLICIES = ['DEVICE_ONLY', 'ENCRYPTED_CENTRAL_SYNC'] as const;
export type BiometricStoragePolicy = (typeof BIOMETRIC_STORAGE_POLICIES)[number];

/**
 * Niveaux de maturité officiels des connecteurs biométriques (transparence stricte).
 */
export const BIOMETRIC_MATURITY_LEVELS = [
  'SPECIFIED',
  'SIMULATED',
  'PROTOCOL_IMPLEMENTED',
  'LAB_VALIDATED',
  'PRODUCTION_CERTIFIED',
] as const;
export type BiometricMaturityLevel = (typeof BIOMETRIC_MATURITY_LEVELS)[number];

/**
 * Ordre officiel validé d'intégration des dispositifs de pointage (Décision propriétaire n° 5).
 */
export const BIOMETRIC_VENDOR_PRIORITY = [
  'KIOSK_PWA_QR_PIN',
  'ZKTECO',
  'HIKVISION',
  'ANVIZ',
  'SUPREMA',
  'OTHER',
] as const;
export type BiometricVendorPriority = (typeof BIOMETRIC_VENDOR_PRIORITY)[number];

export const INFRA_PROFILES = ['production', 'docker', 'sandbox'] as const;
export type InfraProfile = (typeof INFRA_PROFILES)[number];

// ============================================================================
// Mission 2 — Référentiels RH RDC, Contrats, Badges QR+PIN, Coffre & Consentements
// (Aucun taux fiscal/social ni barème salarial codé en dur)
// ============================================================================

export const DRC_PROFESSIONAL_CATEGORIES = [
  'MANOEUVRE_ORDINAIRE',
  'MANOEUVRE_LOURD',
  'TRAVAILLEUR_SEMI_QUALIFIE',
  'TRAVAILLEUR_QUALIFIE',
  'TRAVAILLEUR_HAUTEMENT_QUALIFIE',
  'AGENT_DE_MAITRISE',
  'CADRE_COLLABORATION',
  'CADRE_DIRECTION',
] as const;
export type DrcProfessionalCategory = (typeof DRC_PROFESSIONAL_CATEGORIES)[number];

export const EMPLOYEE_GENDERS = ['F', 'M'] as const;
export type EmployeeGender = (typeof EMPLOYEE_GENDERS)[number];

export const MARITAL_STATUSES = [
  'SINGLE',
  'MARRIED',
  'DIVORCED',
  'WIDOWED',
  'LEGAL_SEPARATION',
] as const;
export type MaritalStatus = (typeof MARITAL_STATUSES)[number];

export const IDENTITY_DOCUMENT_TYPES = [
  'CARTE_ELECTEUR_CENI',
  'CARTE_IDENTITE_ONIP',
  'PASSEPORT',
  'CARTE_RESIDENT',
  'PERMIS_TRAVAIL_ETRANGER',
] as const;
export type IdentityDocumentType = (typeof IDENTITY_DOCUMENT_TYPES)[number];

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'MOBILE_MONEY', 'CASH'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const MOBILE_MONEY_OPERATORS = [
  'MPESA',
  'AIRTEL_MONEY',
  'ORANGE_MONEY',
  'AFRIMONEY',
] as const;
export type MobileMoneyOperator = (typeof MOBILE_MONEY_OPERATORS)[number];

export const EMPLOYEE_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
  'TERMINATED',
] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/**
 * Mode d'identification de présence :
 * - QR_PIN_ONLY (défaut obligatoire) : pointage par badge QR + PIN Argon2id sans biométrie.
 * - BIOMETRIC_OR_QR_PIN : activable uniquement après consentement explicite valide ;
 *   l'alternative QR + PIN demeure toujours opérationnelle en parallèle.
 */
export const EMPLOYEE_ATTENDANCE_MODES = ['QR_PIN_ONLY', 'BIOMETRIC_OR_QR_PIN'] as const;
export type EmployeeAttendanceMode = (typeof EMPLOYEE_ATTENDANCE_MODES)[number];

export const DEPENDENT_RELATIONSHIPS = [
  'SPOUSE',
  'CHILD_LEGITIMATE',
  'CHILD_RECOGNIZED',
  'LEGAL_WARD',
] as const;
export type DependentRelationship = (typeof DEPENDENT_RELATIONSHIPS)[number];

export const CONTRACT_TYPES = [
  'CDI',
  'CDD',
  'JOURNALIER',
  'STAGE_PROFESSIONNEL',
  'CONSULTANT',
  'INTERIM',
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'SUSPENDED',
  'EXPIRED',
  'TERMINATED',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const PAY_FREQUENCIES = ['MONTHLY', 'BIWEEKLY', 'DAILY'] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const BADGE_STATUSES = ['ACTIVE', 'REVOKED', 'LOST', 'EXPIRED'] as const;
export type BadgeStatus = (typeof BADGE_STATUSES)[number];

export const DOCUMENT_CATEGORIES = [
  'IDENTITY_DOC',
  'EMPLOYMENT_CONTRACT',
  'CONTRACT_AMENDMENT',
  'ONEM_VISA',
  'CNSS_CARD',
  'DIPLOMA_CERTIFICATE',
  'MEDICAL_FITNESS',
  'SIGNED_CONSENT',
  'DISCIPLINARY',
  'OTHER',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export type AllowedDocumentMimeType = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

export const MAX_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024; // 5 Mo par pièce RH

export const CONSENT_TYPES = [
  'PERSONAL_DATA_PROCESSING',
  'BIOMETRIC_DEVICE_ONLY',
  'BIOMETRIC_CENTRAL_TEMPLATE',
  'BADGE_PHOTO',
  'ATTENDANCE_GEOLOCATION',
  'ELECTRONIC_PAYSLIP',
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export const CONSENT_DECISIONS = ['GRANTED', 'REFUSED', 'WITHDRAWN'] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

export const CONSENT_COLLECTION_METHODS = [
  'WRITTEN_SIGNED_UPLOAD',
  'HR_ATTESTED_PAPER',
  'EMPLOYEE_PORTAL_EXPLICIT',
] as const;
export type ConsentCollectionMethod = (typeof CONSENT_COLLECTION_METHODS)[number];
