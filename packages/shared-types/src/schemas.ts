import { z } from 'zod';
import {
  BIOMETRIC_STORAGE_POLICIES,
  DRC_TIMEZONES,
  LEGAL_FORMS,
  SECTOR_CODES,
  SITE_TYPES,
  SUPPORTED_CURRENCIES,
  TENANT_STATUSES,
} from './constants';
import { PERMISSION_CATALOG, SCOPE_TYPES } from './rbac';

const VALID_PERMISSION_CODES = new Set<string>(PERMISSION_CATALOG.map((p) => p.code));

export const strongPasswordSchema = z
  .string()
  .min(12, 'Le mot de passe doit contenir au moins 12 caractères.')
  .max(128, 'Le mot de passe ne peut pas dépasser 128 caractères.')
  .regex(/[A-Z]/, 'Le mot de passe doit contenir au moins une lettre majuscule.')
  .regex(/[a-z]/, 'Le mot de passe doit contenir au moins une lettre minuscule.')
  .regex(/[0-9]/, 'Le mot de passe doit contenir au moins un chiffre.')
  .regex(/[^A-Za-z0-9]/, 'Le mot de passe doit contenir au moins un caractère spécial.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Adresse courriel invalide.')
  .max(255);

export const bootstrapSuperAdminSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Nom complet requis.').max(160),
    email: emailSchema,
    password: strongPasswordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Mot de passe requis.').max(128),
  })
  .strict();

export const verifyMfaLoginSchema = z
  .object({
    mfaChallengeToken: z.string().min(20).max(2048),
    code: z.string().trim().min(6).max(20),
  })
  .strict();

export const enableMfaSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Le code TOTP doit comporter exactement 6 chiffres.'),
  })
  .strict();

export const switchTenantSchema = z
  .object({
    tenantId: z.string().uuid('Identifiant d’entreprise invalide.'),
  })
  .strict();

export const timezoneSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .refine(
    (tz) => {
      try {
        Intl.DateTimeFormat('fr-CD', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Fuseau horaire IANA invalide (ex. Africa/Kinshasa ou Africa/Lubumbashi).' },
  );

export const drcTimezoneSchema = z.enum(DRC_TIMEZONES);

export const createTenantSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(63)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'Le code URL (slug) ne peut contenir que des lettres minuscules, chiffres et tirets.',
      ),
    legalName: z.string().trim().min(2, 'Raison sociale requise.').max(255),
    tradeName: z.string().trim().max(255).optional().nullable(),
    legalForm: z.enum(LEGAL_FORMS),
    sectorCode: z.enum(SECTOR_CODES).default('GENERAL'),
    rccm: z.string().trim().max(100).optional().nullable(),
    idNat: z.string().trim().max(100).optional().nullable(),
    taxIdDgi: z.string().trim().max(100).optional().nullable(),
    cnssEmployerNumber: z.string().trim().max(100).optional().nullable(),
    inppEmployerNumber: z.string().trim().max(100).optional().nullable(),
    onemEmployerNumber: z.string().trim().max(100).optional().nullable(),
    defaultCurrency: z.enum(SUPPORTED_CURRENCIES).default('CDF'),
    matriculePattern: z
      .string()
      .trim()
      .min(5)
      .max(120)
      .refine((p) => /\{SEQ:\d+\}/.test(p), {
        message: 'Le modèle de matricule doit contenir un compteur séquentiel (ex. {SEQ:5}).',
      })
      .default('{SITE}-{YYYY}-{SEQ:5}'),
    isDemoTenant: z.boolean().default(false),
    headquartersSite: z
      .object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .min(2)
          .max(32)
          .regex(/^[A-Z0-9_-]+$/, 'Code site invalide.'),
        name: z.string().trim().min(2).max(200),
        province: z.string().trim().min(2).max(80),
        city: z.string().trim().min(2).max(100),
        commune: z.string().trim().max(100).optional().nullable(),
        addressLine: z.string().trim().max(500).optional().nullable(),
        timezone: timezoneSchema,
      })
      .strict(),
    initialAdmin: z
      .object({
        fullName: z.string().trim().min(2).max(160),
        email: emailSchema,
        password: strongPasswordSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const updateTenantStatusSchema = z
  .object({
    status: z.enum(TENANT_STATUSES),
    reason: z.string().trim().min(5, 'Motif obligatoire (min. 5 caractères).').max(500),
  })
  .strict();

export const updateTenantProfileSchema = z
  .object({
    legalName: z.string().trim().min(2).max(255).optional(),
    tradeName: z.string().trim().max(255).optional().nullable(),
    legalForm: z.enum(LEGAL_FORMS).optional(),
    sectorCode: z.enum(SECTOR_CODES).optional(),
    rccm: z.string().trim().max(100).optional().nullable(),
    idNat: z.string().trim().max(100).optional().nullable(),
    taxIdDgi: z.string().trim().max(100).optional().nullable(),
    cnssEmployerNumber: z.string().trim().max(100).optional().nullable(),
    inppEmployerNumber: z.string().trim().max(100).optional().nullable(),
    onemEmployerNumber: z.string().trim().max(100).optional().nullable(),
    defaultCurrency: z.enum(SUPPORTED_CURRENCIES).optional(),
    matriculePattern: z
      .string()
      .trim()
      .min(5)
      .max(120)
      .refine((p) => /\{SEQ:\d+\}/.test(p), {
        message: 'Le modèle de matricule doit contenir un compteur séquentiel (ex. {SEQ:5}).',
      })
      .optional(),
  })
  .strict();

export const updateBiometricPolicySchema = z
  .object({
    policy: z.enum(BIOMETRIC_STORAGE_POLICIES),
    centralTemplateStorageEnabled: z.boolean(),
    legalAuthorizationRef: z.string().trim().max(160).optional().nullable(),
    reason: z.string().trim().min(10, 'Justification juridique et opérationnelle obligatoire.').max(1000),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.policy === 'DEVICE_ONLY' && data.centralTemplateStorageEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['centralTemplateStorageEnabled'],
        message:
          'Le stockage central de gabarits est strictement interdit lorsque la politique est DEVICE_ONLY.',
      });
    }
    if (data.policy === 'ENCRYPTED_CENTRAL_SYNC') {
      if (!data.legalAuthorizationRef || data.legalAuthorizationRef.trim().length < 5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['legalAuthorizationRef'],
          message:
            'Une référence d’autorisation juridique valide (ex. dossier APD / validation légale) est obligatoire avant toute activation centrale.',
        });
      }
    }
  });

export const createSiteSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(32)
      .regex(/^[A-Z0-9_-]+$/, 'Le code site ne peut contenir que lettres majuscules, chiffres, _ et -.'),
    name: z.string().trim().min(2).max(200),
    siteType: z.enum(SITE_TYPES).default('BRANCH'),
    province: z.string().trim().min(2).max(80),
    city: z.string().trim().min(2).max(100),
    commune: z.string().trim().max(100).optional().nullable(),
    addressLine: z.string().trim().max(500).optional().nullable(),
    timezone: timezoneSchema,
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
    geofenceRadiusMeters: z.number().int().min(20).max(50_000).optional().nullable(),
    transportZoneCode: z.string().trim().max(40).optional().nullable(),
    isHeadquarters: z.boolean().default(false),
  })
  .strict();

export const updateSiteSchema = createSiteSchema
  .partial()
  .extend({
    status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  })
  .strict();

export const createDepartmentSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(32)
      .regex(/^[A-Z0-9_-]+$/, 'Code département invalide.'),
    name: z.string().trim().min(2).max(160),
    siteId: z.string().uuid().optional().nullable(),
    parentDepartmentId: z.string().uuid().optional().nullable(),
  })
  .strict();

export const createCustomRoleSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(3)
      .max(48)
      .regex(/^[A-Z][A-Z0-9_]+$/, 'Code rôle invalide (ex. HR_ASSISTANT).'),
    name: z.string().trim().min(3).max(120),
    description: z.string().trim().max(500).optional().nullable(),
    permissions: z
      .array(
        z.string().refine((code) => VALID_PERMISSION_CODES.has(code), {
          message: 'Permission inconnue.',
        }),
      )
      .min(1, 'Au moins une permission est requise.'),
  })
  .strict();

export const createTenantMemberSchema = z
  .object({
    email: emailSchema,
    fullName: z.string().trim().min(2).max(160),
    password: strongPasswordSchema.optional(),
    roleId: z.string().uuid('Rôle requis.'),
    scopeType: z.enum(SCOPE_TYPES).default('ALL_SITES'),
    siteIds: z.array(z.string().uuid()).default([]),
    mfaRequired: z.boolean().default(false),
    expiresAt: z
      .string()
      .datetime({ offset: true, message: 'Date d’expiration ISO-8601 avec fuseau horaire requise.' })
      .optional()
      .nullable(),
    supportJustification: z.string().trim().min(10).max(500).optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.scopeType === 'SELECTED_SITES' && data.siteIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['siteIds'],
        message: 'Au moins un établissement doit être sélectionné pour le périmètre SELECTED_SITES.',
      });
    }
    if (data.scopeType !== 'SELECTED_SITES' && data.siteIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['siteIds'],
        message: 'La liste siteIds ne peut être renseignée qu’avec le périmètre SELECTED_SITES.',
      });
    }
  });

export type BootstrapSuperAdminInput = z.infer<typeof bootstrapSuperAdminSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type VerifyMfaLoginInput = z.infer<typeof verifyMfaLoginSchema>;
export type EnableMfaInput = z.infer<typeof enableMfaSchema>;
export type SwitchTenantInput = z.infer<typeof switchTenantSchema>;
export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantStatusInput = z.infer<typeof updateTenantStatusSchema>;
export type UpdateTenantProfileInput = z.infer<typeof updateTenantProfileSchema>;
export type UpdateBiometricPolicyInput = z.infer<typeof updateBiometricPolicySchema>;
export type CreateSiteInput = z.infer<typeof createSiteSchema>;
export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type CreateCustomRoleInput = z.infer<typeof createCustomRoleSchema>;
export type CreateTenantMemberInput = z.infer<typeof createTenantMemberSchema>;
