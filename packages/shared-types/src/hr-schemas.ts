import { z } from 'zod';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  CONSENT_COLLECTION_METHODS,
  CONSENT_TYPES,
  CONTRACT_STATUSES,
  CONTRACT_TYPES,
  DEPENDENT_RELATIONSHIPS,
  DOCUMENT_CATEGORIES,
  DRC_PROFESSIONAL_CATEGORIES,
  EMPLOYEE_GENDERS,
  EMPLOYEE_STATUSES,
  IDENTITY_DOCUMENT_TYPES,
  MARITAL_STATUSES,
  MOBILE_MONEY_OPERATORS,
  PAYMENT_METHODS,
  PAY_FREQUENCIES,
  SUPPORTED_CURRENCIES,
} from './constants';

const ISO_DATE_FORMAT_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MIN_ISO_CALENDAR_YEAR = 1900;
const MAX_ISO_CALENDAR_YEAR = 2100;

/**
 * Vérifie strictement qu'une chaîne AAAA-MM-JJ correspond à une date réelle du calendrier
 * grégorien (en UTC, sans report silencieux de `Date.parse`, incluant la règle complète des
 * années bissextiles : divisible par 4, sauf siècles non divisibles par 400).
 */
export function isStrictIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_FORMAT_REGEX.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  if (
    year < MIN_ISO_CALENDAR_YEAR ||
    year > MAX_ISO_CALENDAR_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }

  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

/**
 * Calcule le nombre exact d'années révolues entre `birthDateIso` et `referenceDateIso`
 * (deux dates calendaires valides au format AAAA-MM-JJ), en tenant compte du mois et du jour
 * (y compris les naissances un 29 février).
 */
export function computeCompletedYears(birthDateIso: string, referenceDateIso: string): number {
  const birthYear = Number(birthDateIso.slice(0, 4));
  const birthMonth = Number(birthDateIso.slice(5, 7));
  const birthDay = Number(birthDateIso.slice(8, 10));

  const refYear = Number(referenceDateIso.slice(0, 4));
  const refMonth = Number(referenceDateIso.slice(5, 7));
  const refDay = Number(referenceDateIso.slice(8, 10));

  let completed = refYear - birthYear;
  if (refMonth < birthMonth || (refMonth === birthMonth && refDay < birthDay)) {
    completed -= 1;
  }
  return completed;
}

/**
 * Ajoute un nombre entier de mois calendaires à une date ISO AAAA-MM-JJ (en UTC),
 * en plafonnant au dernier jour réel du mois cible (ex. 2024-02-29 + 24 mois -> 2026-02-28).
 */
export function addCalendarMonthsIso(dateIso: string, monthsToAdd: number): string {
  const year = Number(dateIso.slice(0, 4));
  const monthIndex = Number(dateIso.slice(5, 7)) - 1;
  const day = Number(dateIso.slice(8, 10));

  const totalMonths = year * 12 + monthIndex + monthsToAdd;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = ((totalMonths % 12) + 12) % 12;
  // Jour 0 du mois suivant = dernier jour réel du mois cible en UTC
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonthIndex + 1, 0),
  ).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  return `${String(targetYear).padStart(4, '0')}-${String(targetMonthIndex + 1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

export const isoDateSchema = z
  .string()
  .trim()
  .regex(ISO_DATE_FORMAT_REGEX, 'Date invalide (format strict AAAA-MM-JJ attendu).')
  .refine(
    isStrictIsoCalendarDate,
    `Date calendaire invalide ou hors plage autorisée (${MIN_ISO_CALENDAR_YEAR}-${MAX_ISO_CALENDAR_YEAR}).`,
  );

const exactDecimalMoneySchema = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(\.\d{1,4})?$/,
    'Montant décimal exact requis (ex. "1250.00" ou "850000", aucun flottant imprécis).',
  )
  .refine((v) => Number(v) > 0, 'Le montant contractuel doit être strictement positif.');

const phoneDrcOrIntlSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9\s-]{6,22}$/, 'Numéro de téléphone invalide.');

const pinCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Le code PIN personnel doit comporter exactement 6 chiffres.');

// ============================================================================
// 1. Postes & Catégories professionnelles RDC
// ============================================================================

export const createJobPositionSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(32)
      .regex(/^[A-Z0-9_-]+$/, 'Code poste invalide (A-Z, 0-9, -, _).'),
    title: z.string().trim().min(2).max(160),
    professionalCategory: z.enum(DRC_PROFESSIONAL_CATEGORIES),
    departmentId: z.string().uuid().optional().nullable(),
  })
  .strict();

// ============================================================================
// 2. Dossiers Employés RDC (état civil, affectation, PII & paiement chiffrés)
// ============================================================================

export const createEmployeeSchema = z
  .object({
    primarySiteId: z.string().uuid('Établissement principal obligatoire.'),
    departmentId: z.string().uuid().optional().nullable(),
    jobPositionId: z.string().uuid().optional().nullable(),
    managerEmployeeId: z.string().uuid().optional().nullable(),
    lastName: z.string().trim().min(2, 'Le nom est obligatoire.').max(100),
    postName: z.string().trim().max(100).optional().nullable(), // Post-nom congolais
    firstName: z.string().trim().min(2, 'Le prénom est obligatoire.').max(100),
    gender: z.enum(EMPLOYEE_GENDERS),
    birthDate: isoDateSchema,
    birthPlace: z.string().trim().max(120).optional().nullable(),
    nationalityCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'Code nationalité ISO-2 attendu (ex. CD).')
      .default('CD'),
    // Qualification résident/expatrié (RF-M02-01) : explicite et optionnelle, jamais déduite
    // automatiquement de la seule nationalité (validation RH / fiscale RDC requise)
    isExpatriate: z.boolean().optional().nullable(),
    maritalStatus: z.enum(MARITAL_STATUSES).default('SINGLE'),
    hireDate: isoDateSchema,
    status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
    workEmail: z.string().trim().toLowerCase().email().max(255).optional().nullable(),
    phonePrimary: phoneDrcOrIntlSchema.optional().nullable(),
    province: z.string().trim().min(2).max(80).optional().nullable(),
    city: z.string().trim().min(2).max(100).optional().nullable(),
    commune: z.string().trim().max(100).optional().nullable(),
    addressLine: z.string().trim().max(500).optional().nullable(),
    emergencyContactName: z.string().trim().max(160).optional().nullable(),
    emergencyContactPhone: phoneDrcOrIntlSchema.optional().nullable(),
    // Identifiants personnels sensibles (chiffrés AES-256-GCM au repos) et suivi d'échéance du titre
    identityDocType: z.enum(IDENTITY_DOCUMENT_TYPES).optional().nullable(),
    identityDocNumber: z.string().trim().min(4).max(64).optional().nullable(),
    identityDocExpiresAt: isoDateSchema.optional().nullable(),
    cnssNumber: z.string().trim().min(4).max(64).optional().nullable(),
    individualTaxId: z.string().trim().min(4).max(64).optional().nullable(),
    // Coordonnées de paiement (chiffrées AES-256-GCM au repos)
    paymentMethod: z.enum(PAYMENT_METHODS).default('BANK_TRANSFER'),
    bankName: z.string().trim().max(120).optional().nullable(),
    bankAccountNumber: z.string().trim().min(6).max(64).optional().nullable(),
    mobileMoneyOperator: z.enum(MOBILE_MONEY_OPERATORS).optional().nullable(),
    mobileMoneyNumber: phoneDrcOrIntlSchema.optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if ((data.identityDocNumber || data.identityDocExpiresAt) && !data.identityDocType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityDocType'],
        message:
          'Le type de pièce ou titre (identité, passeport, carte de résident, permis de travail) est obligatoire lorsqu’un numéro ou une date d’expiration est fourni.',
      });
    }
    if (data.identityDocExpiresAt && data.identityDocExpiresAt <= data.birthDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityDocExpiresAt'],
        message:
          'La date d’expiration de la pièce ou du titre doit être postérieure à la date de naissance.',
      });
    }
    if (data.hireDate < data.birthDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hireDate'],
        message: 'La date d’embauche ne peut pas être antérieure à la date de naissance.',
      });
    } else if (computeCompletedYears(data.birthDate, data.hireDate) < 16) {
      // Calcul exact en années révolues (mois et jour inclus) — seuil par défaut de 16 ans révolus ;
      // tout régime dérogatoire éventuel relève d'une décision propriétaire et validation juridique RDC.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['birthDate'],
        message:
          'Âge minimum à l’embauche non atteint : l’agent doit avoir au moins 16 ans révolus à la date d’embauche.',
      });
    }
    if (data.mobileMoneyNumber && !data.mobileMoneyOperator) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mobileMoneyOperator'],
        message: 'L’opérateur Mobile Money (M-Pesa, Airtel, Orange, Afrimoney) est requis.',
      });
    }
  });

export const updateEmployeeSchema = z
  .object({
    primarySiteId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional().nullable(),
    jobPositionId: z.string().uuid().optional().nullable(),
    managerEmployeeId: z.string().uuid().optional().nullable(),
    lastName: z.string().trim().min(2).max(100).optional(),
    postName: z.string().trim().max(100).optional().nullable(),
    firstName: z.string().trim().min(2).max(100).optional(),
    isExpatriate: z.boolean().optional().nullable(),
    maritalStatus: z.enum(MARITAL_STATUSES).optional(),
    status: z.enum(EMPLOYEE_STATUSES).optional(),
    terminationDate: isoDateSchema.optional().nullable(),
    terminationReason: z.string().trim().min(5).max(500).optional().nullable(),
    workEmail: z.string().trim().toLowerCase().email().max(255).optional().nullable(),
    phonePrimary: phoneDrcOrIntlSchema.optional().nullable(),
    province: z.string().trim().min(2).max(80).optional().nullable(),
    city: z.string().trim().min(2).max(100).optional().nullable(),
    commune: z.string().trim().max(100).optional().nullable(),
    addressLine: z.string().trim().max(500).optional().nullable(),
    emergencyContactName: z.string().trim().max(160).optional().nullable(),
    emergencyContactPhone: phoneDrcOrIntlSchema.optional().nullable(),
    identityDocType: z.enum(IDENTITY_DOCUMENT_TYPES).optional().nullable(),
    identityDocNumber: z.string().trim().min(4).max(64).optional().nullable(),
    identityDocExpiresAt: isoDateSchema.optional().nullable(),
    cnssNumber: z.string().trim().min(4).max(64).optional().nullable(),
    individualTaxId: z.string().trim().min(4).max(64).optional().nullable(),
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    bankName: z.string().trim().max(120).optional().nullable(),
    bankAccountNumber: z.string().trim().min(6).max(64).optional().nullable(),
    mobileMoneyOperator: z.enum(MOBILE_MONEY_OPERATORS).optional().nullable(),
    mobileMoneyNumber: phoneDrcOrIntlSchema.optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.status === 'TERMINATED' && (!data.terminationDate || !data.terminationReason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminationReason'],
        message: 'La date et le motif de fin de service sont obligatoires pour clôturer un dossier.',
      });
    }
  });

export const createDependentSchema = z
  .object({
    fullName: z.string().trim().min(2).max(160),
    relationship: z.enum(DEPENDENT_RELATIONSHIPS),
    birthDate: isoDateSchema.optional().nullable(),
    isTaxDependent: z.boolean().default(true),
    isPfBeneficiary: z.boolean().default(true),
    notes: z.string().trim().max(400).optional().nullable(),
  })
  .strict();

// ============================================================================
// 3. Contrats de travail RDC (CDI, CDD, Journalier, Stage, Consultant, Intérim)
// ============================================================================

export const createContractSchema = z
  .object({
    contractNumber: z
      .string()
      .trim()
      .toUpperCase()
      .min(3)
      .max(64)
      .regex(/^[A-Z0-9_./-]+$/, 'Référence contrat invalide.'),
    contractType: z.enum(CONTRACT_TYPES),
    siteId: z.string().uuid(),
    jobPositionId: z.string().uuid().optional().nullable(),
    startDate: isoDateSchema,
    endDate: isoDateSchema.optional().nullable(),
    probationEndDate: isoDateSchema.optional().nullable(),
    cddRenewalCount: z.number().int().min(0).max(10).default(0),
    weeklyHours: z.number().min(1).max(72).default(45),
    payCurrency: z.enum(SUPPORTED_CURRENCIES),
    payFrequency: z.enum(PAY_FREQUENCIES).default('MONTHLY'),
    baseSalary: exactDecimalMoneySchema,
    hiringPlace: z.string().trim().min(2).max(120),
    onemVisaRef: z.string().trim().max(80).optional().nullable(),
    onemVisaDate: isoDateSchema.optional().nullable(),
    signedDocumentId: z.string().uuid().optional().nullable(),
    status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.contractType === 'CDI' && data.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'Un contrat à durée indéterminée (CDI) ne doit pas comporter de date de fin.',
      });
    }
    if (
      (data.contractType === 'CDD' ||
        data.contractType === 'STAGE_PROFESSIONNEL' ||
        data.contractType === 'INTERIM') &&
      !data.endDate
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: `Une date de fin est obligatoire pour un contrat de type ${data.contractType}.`,
      });
    }
    if (data.endDate && data.endDate < data.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'La date de fin ne peut pas être antérieure à la date de début.',
      });
    }
    if (data.probationEndDate && data.probationEndDate < data.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['probationEndDate'],
        message: 'La fin de période d’essai ne peut pas précéder le début du contrat.',
      });
    }
    if (data.probationEndDate && data.endDate && data.probationEndDate > data.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['probationEndDate'],
        message:
          'La fin de période d’essai ne peut pas dépasser la date de fin prévue du contrat.',
      });
    }
  });

export const updateContractStatusSchema = z
  .object({
    status: z.enum(CONTRACT_STATUSES),
    reason: z.string().trim().min(5, 'Motif obligatoire (min. 5 caractères).').max(500),
  })
  .strict();

// ============================================================================
// 4. Badges QR + Code PIN Argon2id (alternative garantie à la biométrie)
// ============================================================================

export const issueBadgeSchema = z
  .object({
    pin: pinCodeSchema,
    expiresAt: isoDateSchema.optional().nullable(),
    replaceReason: z.string().trim().min(5).max(300).optional().nullable(),
  })
  .strict();

export const rotateBadgePinSchema = z
  .object({
    newPin: pinCodeSchema,
    reason: z.string().trim().min(5, 'Motif de réinitialisation PIN obligatoire.').max(300),
  })
  .strict();

export const revokeBadgeSchema = z
  .object({
    status: z.enum(['REVOKED', 'LOST']).default('REVOKED'),
    reason: z.string().trim().min(5, 'Motif de révocation obligatoire (perte, vol, départ).').max(300),
  })
  .strict();

export const verifyQrPinSchema = z
  .object({
    qrPayload: z.string().trim().min(32).max(512),
    pin: pinCodeSchema,
    siteId: z.string().uuid('Établissement de vérification obligatoire.'),
  })
  .strict();

// ============================================================================
// 5. Coffre Documentaire S3 (isolé par tenant, chiffré enveloppe & SHA-256)
// ============================================================================

export const uploadEmployeeDocumentSchema = z
  .object({
    category: z.enum(DOCUMENT_CATEGORIES),
    title: z.string().trim().min(2).max(160),
    originalFilename: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .refine((n) => !n.includes('/') && !n.includes('\\') && !n.includes('..'), {
        message: 'Nom de fichier invalide.',
      }),
    mimeType: z.enum(ALLOWED_DOCUMENT_MIME_TYPES),
    contentBase64: z.string().trim().min(8).max(7_500_000), // <= 5 Mo décodé
    expiresAt: isoDateSchema.optional().nullable(),
    retentionUntil: isoDateSchema.optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.expiresAt && data.retentionUntil && data.retentionUntil < data.expiresAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retentionUntil'],
        message:
          'La date de fin de conservation ne peut pas être antérieure à la date d’expiration de la pièce.',
      });
    }
  });

export const deleteEmployeeDocumentSchema = z
  .object({
    reason: z.string().trim().min(5, 'Motif d’archivage/suppression obligatoire.').max(400),
  })
  .strict();

// ============================================================================
// 6. Registre légal des consentements RDC (JAMAIS précoché, révocable à tout moment)
// ============================================================================

export const recordEmployeeConsentSchema = z
  .object({
    consentType: z.enum(CONSENT_TYPES),
    // Décision explicite obligatoire (aucune valeur par défaut -> jamais précoché)
    decision: z.enum(['GRANTED', 'REFUSED']),
    policyVersion: z.string().trim().min(2).max(40),
    collectionMethod: z.enum(CONSENT_COLLECTION_METHODS),
    noticeSummary: z
      .string()
      .trim()
      .min(15, 'Le résumé de la notice d’information remise à l’agent est obligatoire.')
      .max(1000),
    // Pas de valeur par défaut : doit être confirmé explicitement à true
    alternativeQrPinOffered: z.literal(true, {
      errorMap: () => ({
        message:
          'Vous devez confirmer explicitement que l’alternative non-biométrique (Badge QR + PIN) sans pénalité a été présentée à l’agent.',
      }),
    }),
    signedDocumentId: z.string().uuid().optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Exigence technique M0 validée (SECURITY_POLICY.md § 3.3 #1 & ROADMAP.md) :
    // tout consentement biométrique accordé (local sur terminal OU centralisé) doit être
    // accompagné de sa preuve écrite signée archivée dans le coffre (signedDocumentId).
    // Les consentements non biométriques conservent leur politique actuelle sans modification automatique.
    if (
      (data.consentType === 'BIOMETRIC_DEVICE_ONLY' ||
        data.consentType === 'BIOMETRIC_CENTRAL_TEMPLATE') &&
      data.decision === 'GRANTED' &&
      !data.signedDocumentId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signedDocumentId'],
        message:
          'Un formulaire de consentement écrit signé et archivé dans le coffre documentaire (signedDocumentId) est obligatoire pour tout consentement biométrique accordé (local sur terminal ou centralisé).',
      });
    }
    if (
      data.collectionMethod === 'WRITTEN_SIGNED_UPLOAD' &&
      data.decision === 'GRANTED' &&
      !data.signedDocumentId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signedDocumentId'],
        message:
          'Veuillez rattacher la pièce de consentement signée lorsque le mode de recueil est WRITTEN_SIGNED_UPLOAD.',
      });
    }
  });

export const withdrawEmployeeConsentSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(5, 'Motif ou référence de la demande de retrait obligatoire.')
      .max(500),
  })
  .strict();

export type CreateJobPositionInput = z.infer<typeof createJobPositionSchema>;
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type CreateDependentInput = z.infer<typeof createDependentSchema>;
export type CreateContractInput = z.infer<typeof createContractSchema>;
export type UpdateContractStatusInput = z.infer<typeof updateContractStatusSchema>;
export type IssueBadgeInput = z.infer<typeof issueBadgeSchema>;
export type RotateBadgePinInput = z.infer<typeof rotateBadgePinSchema>;
export type RevokeBadgeInput = z.infer<typeof revokeBadgeSchema>;
export type VerifyQrPinInput = z.infer<typeof verifyQrPinSchema>;
export type UploadEmployeeDocumentInput = z.infer<typeof uploadEmployeeDocumentSchema>;
export type DeleteEmployeeDocumentInput = z.infer<typeof deleteEmployeeDocumentSchema>;
export type RecordEmployeeConsentInput = z.infer<typeof recordEmployeeConsentSchema>;
export type WithdrawEmployeeConsentInput = z.infer<typeof withdrawEmployeeConsentSchema>;
