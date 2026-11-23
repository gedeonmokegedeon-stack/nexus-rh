/**
 * Types et libellés français RDC pour le module Cœur RH (Mission 2).
 * Zéro taux fiscal/social de paie codé en dur.
 */

export interface SiteOption {
  id: string;
  code: string;
  name: string;
  province: string;
  city: string;
  timezone: 'Africa/Kinshasa' | 'Africa/Lubumbashi';
  status: string;
}

export interface DepartmentOption {
  id: string;
  code: string;
  name: string;
  siteId: string | null;
}

export interface JobPositionItem {
  id: string;
  tenantId: string;
  departmentId: string | null;
  code: string;
  title: string;
  professionalCategory: string;
  echelon: string | null;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
}

export interface EmployeeItem {
  id: string;
  tenantId: string;
  primarySiteId: string;
  departmentId: string | null;
  jobPositionId: string | null;
  managerEmployeeId: string | null;
  userId: string | null;
  matricule: string;
  lastName: string;
  postName: string | null;
  firstName: string;
  gender: 'M' | 'F';
  birthDate: string;
  birthPlace: string | null;
  nationalityCode: string;
  maritalStatus: string;
  taxDependentsCount: number;
  hireDate: string;
  seniorityDate: string;
  terminationDate: string | null;
  terminationReason: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  phonePrimary: string | null;
  phoneSecondary: string | null;
  province: string | null;
  city: string | null;
  commune: string | null;
  physicalAddress: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;
  identityDocType: string | null;
  identityDocMasked: string | null;
  cnssNumberMasked: string | null;
  individualTaxIdMasked: string | null;
  hasEncryptedPii?: boolean;
  paymentMethod: string;
  bankName: string | null;
  bankAccountMasked: string | null;
  mobileMoneyOperator: string | null;
  mobileMoneyMasked: string | null;
  hasEncryptedPayment?: boolean;
  attendanceMode: 'QR_PIN_ONLY' | 'BIOMETRIC_OR_QR_PIN';
  status: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'TERMINATED';
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeSensitiveData {
  employeeId: string;
  matricule: string;
  identityDocType: string | null;
  identityDocNumber: string | null;
  cnssNumber: string | null;
  individualTaxId: string | null;
  payment: {
    paymentMethod: string;
    bankName: string | null;
    bankAccountNumber: string | null;
    mobileMoneyOperator: string | null;
    mobileMoneyNumber: string | null;
  } | null;
}

export interface EmployeeDependentItem {
  id: string;
  employeeId: string;
  fullName: string;
  relationship: string;
  birthDate: string | null;
  isTaxDependent: boolean;
  notes: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
}

export interface EmploymentContractItem {
  id: string;
  employeeId: string;
  siteId: string;
  jobPositionId: string | null;
  contractNumber: string;
  contractType: 'CDI' | 'CDD' | 'JOURNALIER' | 'APPRENTISSAGE' | 'STAGE';
  startDate: string;
  endDate: string | null;
  probationEndDate: string | null;
  cddRenewalCount: number;
  weeklyHours: number;
  payCurrency: 'CDF' | 'USD';
  payFrequency: 'MONTHLY' | 'DAILY';
  baseSalary: string | null;
  salaryRedacted: boolean;
  hiringPlace: string;
  onemVisaRef: string | null;
  onemVisaDate: string | null;
  signedDocumentId: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'TERMINATED';
  terminationReason: string | null;
  terminatedAt: string | null;
  createdAt: string;
}

export interface EmployeeBadgeItem {
  id: string;
  employeeId: string;
  badgeCode: string;
  status: 'ACTIVE' | 'REVOKED' | 'LOST' | 'EXPIRED';
  failedPinAttempts: number;
  pinLockedUntil: string | null;
  lastVerifiedAt: string | null;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface EmployeeDocumentItem {
  id: string;
  employeeId: string;
  category: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256Checksum: string;
  storageBucket: string;
  objectKey: string;
  isEnvelopeEncrypted: boolean;
  retentionUntil: string | null;
  status: string;
  createdAt: string;
}

export interface EmployeeConsentItem {
  id: string;
  employeeId: string;
  consentType: string;
  decision: 'GRANTED' | 'REFUSED' | 'WITHDRAWN';
  policyVersion: string;
  collectionMethod: string;
  noticeSummary: string;
  alternativeQrPinOffered: boolean;
  signedDocumentId: string | null;
  decidedAt: string;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
}

export const PROFESSIONAL_CATEGORY_LABELS: Record<string, string> = {
  MANOEUVRE_ORDINAIRE: 'Cat. I — Manœuvre ordinaire',
  MANOEUVRE_LOURD: 'Cat. II — Manœuvre lourd',
  TRAVAILLEUR_SPECIALISE: 'Cat. III — Travailleur spécialisé',
  TRAVAILLEUR_SEMI_QUALIFIE: 'Cat. IV — Travailleur semi-qualifié',
  TRAVAILLEUR_QUALIFIE: 'Cat. V — Travailleur qualifié',
  TRAVAILLEUR_HAUTEMENT_QUALIFIE: 'Cat. VI — Hautement qualifié',
  AGENT_DE_MAITRISE: 'Agent de maîtrise',
  CADRE_COLLABORATION: 'Cadre de collaboration',
  CADRE_DIRECTION: 'Cadre de direction',
  HORS_CADRE: 'Hors cadre',
};

export const EMPLOYEE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Actif',
  ON_LEAVE: 'En congé',
  SUSPENDED: 'Suspendu',
  TERMINATED: 'Sorti / Clôturé',
};

export const MARITAL_STATUS_LABELS: Record<string, string> = {
  SINGLE: 'Célibataire',
  MARRIED: 'Marié(e)',
  DIVORCED: 'Divorcé(e)',
  WIDOWED: 'Veuf / Veuve',
  LEGAL_SEPARATION: 'Séparé(e) légalement',
};

export const IDENTITY_DOC_LABELS: Record<string, string> = {
  CARTE_ELECTEUR_CENI: 'Carte d’électeur (CENI)',
  PASSEPORT: 'Passeport',
  CARTE_IDENTITE_NATIONALE: 'Carte d’identité nationale (ONIP)',
  PERMIS_CONDUIRE: 'Permis de conduire',
  CARTE_RESIDENT_ETRANGER: 'Carte de résident / travail expatrié',
  ATTESTATION_IDENTITE: 'Attestation tenant lieu d’identité',
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  BANK_TRANSFER: 'Virement bancaire',
  MOBILE_MONEY: 'Mobile Money (RDC)',
  CASH: 'Espèces (guichet)',
  MIXED: 'Mixte (Banque + Mobile Money)',
};

export const MOBILE_MONEY_LABELS: Record<string, string> = {
  MPESA: 'Vodacom M-Pesa',
  AIRTEL_MONEY: 'Airtel Money',
  ORANGE_MONEY: 'Orange Money',
  AFRIMONEY: 'Afrimoney',
};

export const DEPENDENT_RELATION_LABELS: Record<string, string> = {
  SPOUSE: 'Conjoint(e) légal(e)',
  CHILD_LEGITIMATE: 'Enfant légitime',
  CHILD_RECOGNIZED: 'Enfant reconnu à l’état civil',
  CHILD_ADOPTED: 'Enfant adopté légalement',
  LEGAL_WARD: 'Pupille sous tutelle légale',
};

export const CONTRACT_TYPE_LABELS: Record<string, string> = {
  CDI: 'CDI — Durée indéterminée',
  CDD: 'CDD — Durée déterminée',
  JOURNALIER: 'Travail journalier',
  APPRENTISSAGE: 'Contrat d’apprentissage',
  STAGE: 'Convention de stage',
};

export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  ACTIVE: 'Actif',
  SUSPENDED: 'Suspendu',
  EXPIRED: 'Arrivé à terme',
  TERMINATED: 'Résilié / Clôturé',
};

export const DOCUMENT_CATEGORY_LABELS: Record<string, string> = {
  IDENTITY_DOC: 'Pièce d’identité (CENI / ONIP / Passeport)',
  EMPLOYMENT_CONTRACT: 'Contrat de travail signé',
  CONTRACT_AMENDMENT: 'Avenant contractuel',
  ONEM_VISA: 'Visa ONEM',
  CNSS_CARD: 'Carte d’immatriculation CNSS',
  SIGNED_CONSENT: 'Formulaire de consentement signé (OL 23/010)',
  MEDICAL_FITNESS: 'Certificat d’aptitude médicale',
  DIPLOMA_CERTIFICATE: 'Diplôme ou attestation professionnelle',
  DISCIPLINARY_RECORD: 'Pièce disciplinaire',
  FAMILY_CIVIL_STATUS: 'Acte d’état civil / ayants droit',
  RIB_BANK_PROOF: 'RIB / Attestation bancaire',
  OTHER_HR: 'Autre pièce administrative RH',
};

export const CONSENT_TYPE_LABELS: Record<string, string> = {
  HR_DATA_PROCESSING: 'Notice de traitement des données RH (OL n° 23/010)',
  BIOMETRIC_DEVICE_ONLY: 'Pointage biométrique local sur terminal (DEVICE_ONLY)',
  BIOMETRIC_CENTRAL_TEMPLATE: 'Synchronisation centrale chiffrée de gabarit (soumis autorisation APD)',
  DOCUMENT_DIGITAL_ARCHIVING: 'Archivage électronique chiffré du dossier individuel',
  PHOTO_BADGE_USAGE: 'Usage de la photographie sur badge professionnel',
};

export const CONSENT_METHOD_LABELS: Record<string, string> = {
  WRITTEN_SIGNED_UPLOAD: 'Formulaire papier signé numérisé (coffre S3)',
  EMPLOYEE_PORTAL_EXPLICIT: 'Validation explicite sur portail agent',
  HR_ASSISTED_WITH_RECEIPT: 'Recueil assisté RH avec récépissé remis à l’agent',
};

export function formatEmployeeFullName(e: {
  lastName: string;
  postName: string | null;
  firstName: string;
}): string {
  return [e.lastName.toUpperCase(), e.postName, e.firstName].filter(Boolean).join(' ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}
