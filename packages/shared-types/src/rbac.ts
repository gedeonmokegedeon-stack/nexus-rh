/**
 * Catalogue canonique des permissions RBAC, rôles standards et règles de séparation
 * des tâches (SoD — Segregation of Duties) de NEXUS RH.
 */

export interface PermissionDefinition {
  readonly code: string;
  readonly module:
    | 'tenant'
    | 'organization'
    | 'rbac'
    | 'employees'
    | 'contracts'
    | 'biometrics'
    | 'attendance'
    | 'leaves'
    | 'payroll'
    | 'reports'
    | 'audit'
    | 'integrations';
  readonly description: string;
  readonly isSensitive: boolean;
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  // Entreprise & gouvernance
  { code: 'tenant.read', module: 'tenant', description: 'Consulter le profil et les paramètres de l’entreprise', isSensitive: false },
  { code: 'tenant.update', module: 'tenant', description: 'Modifier l’identité légale et la configuration de l’entreprise', isSensitive: true },
  { code: 'tenant.biometric_policy.manage', module: 'tenant', description: 'Modifier la politique juridique de stockage biométrique', isSensitive: true },

  // Établissements & organigramme
  { code: 'organization.sites.read', module: 'organization', description: 'Consulter les établissements et leurs fuseaux horaires', isSensitive: false },
  { code: 'organization.sites.manage', module: 'organization', description: 'Créer et modifier les établissements/sites', isSensitive: false },
  { code: 'organization.departments.read', module: 'organization', description: 'Consulter les départements et services', isSensitive: false },
  { code: 'organization.departments.manage', module: 'organization', description: 'Créer et modifier les départements et services', isSensitive: false },

  // Utilisateurs, rôles & permissions
  { code: 'rbac.roles.read', module: 'rbac', description: 'Consulter les rôles et la matrice des permissions', isSensitive: false },
  { code: 'rbac.roles.manage', module: 'rbac', description: 'Créer et modifier des rôles personnalisés', isSensitive: true },
  { code: 'rbac.members.read', module: 'rbac', description: 'Consulter les utilisateurs et leurs périmètres d’accès', isSensitive: false },
  { code: 'rbac.members.manage', module: 'rbac', description: 'Affecter des utilisateurs, rôles et périmètres de sites', isSensitive: true },

  // Agents, contrats, badges QR+PIN, coffre documentaire & consentements (Mission 2)
  { code: 'employees.read', module: 'employees', description: 'Consulter les dossiers agents du périmètre autorisé (identifiants sensibles masqués)', isSensitive: false },
  { code: 'employees.manage', module: 'employees', description: 'Créer et modifier les dossiers agents, ayants droit et matricules atomiques', isSensitive: false },
  { code: 'employees.pii.read', module: 'employees', description: 'Déchiffrer et consulter les identifiants sensibles d’un agent (lecture journalisée)', isSensitive: true },
  { code: 'employees.salary.read', module: 'employees', description: 'Consulter les éléments salariaux et bancaires déchiffrés des agents', isSensitive: true },
  { code: 'employees.salary.manage', module: 'employees', description: 'Modifier les salaires et coordonnées de paiement', isSensitive: true },
  { code: 'employees.badges.manage', module: 'employees', description: 'Émettre, renouveler, révoquer un badge QR et définir/réinitialiser le code PIN Argon2id', isSensitive: true },
  { code: 'employees.badges.verify', module: 'employees', description: 'Vérifier l’authenticité d’un badge QR + code PIN sur les établissements autorisés', isSensitive: false },
  { code: 'employees.documents.read', module: 'employees', description: 'Consulter et télécharger les pièces justificatives du coffre documentaire RH', isSensitive: true },
  { code: 'employees.documents.manage', module: 'employees', description: 'Téléverser et archiver des pièces justificatives dans le coffre documentaire S3', isSensitive: true },
  { code: 'employees.consents.read', module: 'employees', description: 'Consulter le registre des consentements légaux et biométriques des agents', isSensitive: false },
  { code: 'contracts.read', module: 'contracts', description: 'Consulter les contrats et avenants', isSensitive: false },
  { code: 'contracts.manage', module: 'contracts', description: 'Créer, renouveler, amender ou clôturer les contrats', isSensitive: true },

  // Biométrie & terminaux
  { code: 'biometrics.consent.manage', module: 'biometrics', description: 'Enregistrer ou révoquer le consentement biométrique écrit d’un agent', isSensitive: true },
  { code: 'biometrics.devices.read', module: 'biometrics', description: 'Consulter l’état du parc de pointeuses et kiosques PWA', isSensitive: false },
  { code: 'biometrics.devices.manage', module: 'biometrics', description: 'Appairer, configurer et synchroniser les terminaux et kiosques', isSensitive: true },
  { code: 'biometrics.enroll', module: 'biometrics', description: 'Déclencher un enrôlement ou une purge biométrique', isSensitive: true },

  // Présences, horaires & congés
  { code: 'attendance.read', module: 'attendance', description: 'Consulter les pointages et feuilles de présence du périmètre', isSensitive: false },
  { code: 'attendance.schedules.manage', module: 'attendance', description: 'Configurer les horaires, vacations (shifts) et jours fériés', isSensitive: false },
  { code: 'attendance.adjust.request', module: 'attendance', description: 'Soumettre une demande de régularisation de pointage motivée', isSensitive: false },
  { code: 'attendance.adjust.approve', module: 'attendance', description: 'Approuver ou rejeter une régularisation de pointage ou heure sup.', isSensitive: true },
  { code: 'leaves.read', module: 'leaves', description: 'Consulter les demandes et soldes de congés du périmètre', isSensitive: false },
  { code: 'leaves.approve', module: 'leaves', description: 'Approuver ou rejeter les demandes de congés', isSensitive: false },
  { code: 'attendance.self', module: 'attendance', description: 'Accéder à son propre espace agent (badge QR, pointages, congés, bulletins)', isSensitive: false },

  // Paie RDC (séparation stricte préparation vs approbation)
  { code: 'payroll.rules.read', module: 'payroll', description: 'Consulter les règles, barèmes et taux de change versionnés', isSensitive: false },
  { code: 'payroll.rules.manage', module: 'payroll', description: 'Paramétrer une nouvelle version des règles fiscales/sociales et taux', isSensitive: true },
  { code: 'payroll.run.calculate', module: 'payroll', description: 'Préparer, simuler et calculer un cycle de paie', isSensitive: true },
  { code: 'payroll.run.approve', module: 'payroll', description: 'Approuver et clôturer définitivement un cycle de paie (4 yeux)', isSensitive: true },
  { code: 'payroll.payslips.read_all', module: 'payroll', description: 'Consulter les bulletins de paie, livres de paie et déclarations', isSensitive: true },

  // Rapports, audit & API
  { code: 'reports.read', module: 'reports', description: 'Consulter et exporter les rapports et statistiques autorisés', isSensitive: false },
  { code: 'audit.read', module: 'audit', description: 'Consulter et vérifier l’intégrité du journal d’audit immuable', isSensitive: true },
  { code: 'integrations.api_keys.manage', module: 'integrations', description: 'Créer et révoquer les clés API externes et webhooks', isSensitive: true },
] as const;

export type PermissionCode = (typeof PERMISSION_CATALOG)[number]['code'];

export const SCOPE_TYPES = ['ALL_SITES', 'SELECTED_SITES', 'OWN_DEPARTMENT', 'SELF_ONLY'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface SystemRoleDefinition {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly mfaRecommendedOrRequired: boolean;
  readonly defaultScope: ScopeType;
  readonly permissions: readonly PermissionCode[];
}

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    code: 'TENANT_ADMIN',
    name: 'Administrateur Entreprise',
    description: 'Administration de la société, des établissements, des utilisateurs, des rôles et de la sécurité (sans cumul préparation + approbation de paie).',
    mfaRecommendedOrRequired: true,
    defaultScope: 'ALL_SITES',
    permissions: [
      'tenant.read',
      'tenant.update',
      'tenant.biometric_policy.manage',
      'organization.sites.read',
      'organization.sites.manage',
      'organization.departments.read',
      'organization.departments.manage',
      'rbac.roles.read',
      'rbac.roles.manage',
      'rbac.members.read',
      'rbac.members.manage',
      'biometrics.devices.read',
      'reports.read',
      'audit.read',
      'integrations.api_keys.manage',
    ],
  },
  {
    code: 'HR_MANAGER',
    name: 'Responsable RH',
    description: 'Gestion complète des agents, contrats, consentements biométriques, horaires, congés et validation RH des temps.',
    mfaRecommendedOrRequired: true,
    defaultScope: 'ALL_SITES',
    permissions: [
      'tenant.read',
      'organization.sites.read',
      'organization.departments.read',
      'organization.departments.manage',
      'employees.read',
      'employees.manage',
      'employees.pii.read',
      'employees.salary.read',
      'employees.salary.manage',
      'employees.badges.manage',
      'employees.badges.verify',
      'employees.documents.read',
      'employees.documents.manage',
      'employees.consents.read',
      'contracts.read',
      'contracts.manage',
      'biometrics.consent.manage',
      'biometrics.devices.read',
      'attendance.read',
      'attendance.schedules.manage',
      'attendance.adjust.approve',
      'leaves.read',
      'leaves.approve',
      'reports.read',
    ],
  },
  {
    code: 'PAYROLL_MANAGER',
    name: 'Gestionnaire de Paie',
    description: 'Paramétrage des rubriques et taux, simulation et calcul de la paie, préparation des états DGI/CNSS/INPP/ONEM (ne peut pas clôturer seul).',
    mfaRecommendedOrRequired: true,
    defaultScope: 'ALL_SITES',
    permissions: [
      'tenant.read',
      'organization.sites.read',
      'organization.departments.read',
      'employees.read',
      'employees.salary.read',
      'contracts.read',
      'attendance.read',
      'leaves.read',
      'payroll.rules.read',
      'payroll.rules.manage',
      'payroll.run.calculate',
      'payroll.payslips.read_all',
      'reports.read',
    ],
  },
  {
    code: 'FINANCE_APPROVER',
    name: 'Approbateur Financier (DAF / DG)',
    description: 'Contrôle des écarts, approbation et clôture définitive des cycles de paie (principe des quatre yeux) et supervision analytique.',
    mfaRecommendedOrRequired: true,
    defaultScope: 'ALL_SITES',
    permissions: [
      'tenant.read',
      'organization.sites.read',
      'organization.departments.read',
      'employees.read',
      'employees.salary.read',
      'payroll.rules.read',
      'payroll.run.approve',
      'payroll.payslips.read_all',
      'reports.read',
      'audit.read',
    ],
  },
  {
    code: 'SITE_MANAGER',
    name: 'Chef d’Établissement / Site',
    description: 'Supervision des présences, plannings, demandes de congés et régularisations uniquement sur les établissements assignés (sans accès aux salaires).',
    mfaRecommendedOrRequired: false,
    defaultScope: 'SELECTED_SITES',
    permissions: [
      'tenant.read',
      'organization.sites.read',
      'organization.departments.read',
      'employees.read',
      'employees.badges.verify',
      'biometrics.devices.read',
      'attendance.read',
      'attendance.adjust.request',
      'attendance.adjust.approve',
      'leaves.read',
      'leaves.approve',
      'reports.read',
    ],
  },
  {
    code: 'BIOMETRIC_ADMIN',
    name: 'Administrateur Parc Biométrique',
    description: 'Appairage, supervision et enrôlement sur les terminaux et kiosques des sites autorisés (aucun accès aux contrats ni aux salaires).',
    mfaRecommendedOrRequired: true,
    defaultScope: 'SELECTED_SITES',
    permissions: [
      'tenant.read',
      'organization.sites.read',
      'employees.read',
      'employees.badges.manage',
      'employees.badges.verify',
      'employees.consents.read',
      'biometrics.devices.read',
      'biometrics.devices.manage',
      'biometrics.enroll',
    ],
  },
  {
    code: 'EMPLOYEE',
    name: 'Agent (Portail Self-Service)',
    description: 'Accès strictement personnel à son badge QR, ses pointages, ses congés et ses bulletins de paie.',
    mfaRecommendedOrRequired: false,
    defaultScope: 'SELF_ONLY',
    permissions: ['attendance.self'],
  },
  {
    code: 'EXTERNAL_AUDITOR',
    name: 'Auditeur / Expert-Comptable (Lecture seule)',
    description: 'Accès temporaire en lecture seule aux livres de paie, déclarations, règles appliquées et journaux d’audit (aucune écriture, aucune biométrie).',
    mfaRecommendedOrRequired: true,
    defaultScope: 'ALL_SITES',
    permissions: [
      'tenant.read',
      'organization.sites.read',
      'payroll.rules.read',
      'payroll.payslips.read_all',
      'reports.read',
      'audit.read',
    ],
  },
] as const;

/**
 * Règles obligatoires de Séparation des Tâches (SoD — Segregation of Duties).
 * Un même utilisateur au sein d'un même tenant ne peut pas cumuler deux permissions incompatibles.
 */
export interface SodConflictRule {
  readonly code: string;
  readonly permissionA: PermissionCode;
  readonly permissionB: PermissionCode;
  readonly reason: string;
}

export const SOD_CONFLICT_RULES: readonly SodConflictRule[] = [
  {
    code: 'SOD_PAYROLL_CALC_VS_APPROVE',
    permissionA: 'payroll.run.calculate',
    permissionB: 'payroll.run.approve',
    reason:
      'Principe des quatre yeux : un même utilisateur ne peut pas à la fois calculer et approuver/clôturer un cycle de paie.',
  },
  {
    code: 'SOD_BIOMETRIC_ENROLL_VS_PAYROLL',
    permissionA: 'biometrics.enroll',
    permissionB: 'payroll.run.calculate',
    reason:
      'Prévention des agents fictifs : l’administrateur qui enrôle les terminaux biométriques ne peut pas calculer la paie.',
  },
  {
    code: 'SOD_ADJUST_REQUEST_AND_SALARY_APPROVE',
    permissionA: 'payroll.rules.manage',
    permissionB: 'payroll.run.approve',
    reason:
      'Contrôle interne financier : l’auteur d’une modification de barème ou de règle de paie ne peut pas approuver seul la clôture financière.',
  },
] as const;

/**
 * Rôles standards d'entreprise pour lesquels la MFA TOTP est strictement obligatoire
 * conformément à SECURITY_POLICY.md § 5.1 (en sus de SUPER_ADMIN au niveau plateforme).
 * Les autres rôles (ex. HR_MANAGER, EXTERNAL_AUDITOR) peuvent également exiger la MFA
 * par politique d'entreprise via `tenant_memberships.mfa_required = true`.
 */
export const MANDATORY_MFA_TENANT_ROLE_CODES = [
  'TENANT_ADMIN',
  'PAYROLL_MANAGER',
  'FINANCE_APPROVER',
  'BIOMETRIC_ADMIN',
] as const;

/**
 * Durée maximale (en heures) d'une délégation support temporaire accordée explicitement
 * par un client à un Super-Administrateur plateforme (SECURITY_POLICY.md § 5.2, C-04).
 */
export const SUPPORT_DELEGATION_MAX_HOURS = 72;

/**
 * Permissions strictement d'échelle entreprise ou multi-sites qui ne peuvent jamais
 * être attribuées avec un périmètre `OWN_DEPARTMENT` ou `SELF_ONLY`.
 */
export const NON_SELF_OR_DEPARTMENT_PERMISSION_CODES = [
  'tenant.update',
  'tenant.biometric_policy.manage',
  'organization.sites.manage',
  'organization.departments.manage',
  'rbac.roles.manage',
  'rbac.members.manage',
  'payroll.rules.manage',
  'payroll.run.calculate',
  'payroll.run.approve',
  'audit.read',
  'integrations.api_keys.manage',
] as const;

/**
 * Détecte tout conflit SoD dans un ensemble de permissions résolues.
 */
export function detectSodConflicts(permissions: Iterable<string>): SodConflictRule[] {
  const set = new Set(permissions);
  return SOD_CONFLICT_RULES.filter(
    (rule) => set.has(rule.permissionA) && set.has(rule.permissionB),
  );
}
