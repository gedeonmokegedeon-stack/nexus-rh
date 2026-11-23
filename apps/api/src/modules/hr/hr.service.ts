import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  computeTenantBlindIndex,
  decryptEnvelope,
  encryptEnvelope,
  hashPin,
  issueSignedBadgeQrToken,
  maskSensitiveValue,
  sha256Hex,
  uuidv7,
  verifyPin,
  verifySignedBadgeQrToken,
  type EnvelopeCiphertext,
} from '@nexus-rh/crypto-audit';
import {
  NexusDatabase,
  and,
  asc,
  departments,
  desc,
  employeeAttendanceBadges,
  employeeConsents,
  employeeDependents,
  employeeDocuments,
  employees,
  employmentContracts,
  eq,
  inArray,
  isNull,
  isPgUniqueViolation,
  jobPositions,
  lte,
  or,
  outboxEvents,
  sites,
  sql,
  tenants,
  type DrizzleTx,
} from '@nexus-rh/database';
import {
  MAX_DOCUMENT_SIZE_BYTES,
  addCalendarMonthsIso,
  type AllowedDocumentMimeType,
  type CreateContractInput,
  type CreateDependentInput,
  type CreateEmployeeInput,
  type CreateJobPositionInput,
  type DeleteEmployeeDocumentInput,
  type IssueBadgeInput,
  type PermissionCode,
  type RecordEmployeeConsentInput,
  type RevokeBadgeInput,
  type RotateBadgePinInput,
  type UpdateContractStatusInput,
  type UpdateEmployeeInput,
  type UploadEmployeeDocumentInput,
  type VerifyQrPinInput,
  type WithdrawEmployeeConsentInput,
} from '@nexus-rh/shared-types';
import type { AppConfig } from '../../config/app-config';
import {
  APP_CONFIG,
  CACHE_LOCK_PORT,
  MESSAGE_BUS_PORT,
  NEXUS_DB,
  OBJECT_STORAGE_PORT,
  type CacheLockPort,
  type MessageBusPort,
  type ObjectStoragePort,
} from '../../infra/ports';
import {
  canAccessEmployeeForPermission,
  canAccessSiteForPermission,
  getPermissionScope,
  hasAllSitesForPermission,
  type AuthenticatedPrincipal,
  type RequestMeta,
} from '../../common/security';

interface TenantHrContext {
  readonly id: string;
  readonly slug: string;
  readonly matriculePattern: string;
  readonly encryptionKeyRef: string;
  readonly biometricStoragePolicy: string;
  readonly centralTemplateStorageEnabled: boolean;
}

interface DecryptedPiiPayload {
  identityDocNumber: string | null;
  cnssNumber: string | null;
  individualTaxId: string | null;
}

interface DecryptedPaymentPayload {
  bankAccountNumber: string | null;
  mobileMoneyNumber: string | null;
}

const MAX_BADGE_PIN_FAILURES = 5;
const BADGE_PIN_LOCKOUT_MINUTES = 15;

@Injectable()
export class HrService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NEXUS_DB) private readonly db: NexusDatabase,
    @Inject(CACHE_LOCK_PORT) private readonly cache: CacheLockPort,
    @Inject(MESSAGE_BUS_PORT) private readonly bus: MessageBusPort,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  // ==========================================================================
  // 1. Postes & Catégories professionnelles RDC
  // ==========================================================================

  async listJobPositions(principal: AuthenticatedPrincipal) {
    const tenantId = principal.activeTenantId!;
    const rows = await this.db.withTenantTransaction(tenantId, principal.userId, (tx) =>
      tx.select().from(jobPositions).orderBy(asc(jobPositions.code)),
    );
    return rows;
  }

  async createJobPosition(
    principal: AuthenticatedPrincipal,
    input: CreateJobPositionInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      if (input.departmentId) {
        const [dept] = await tx
          .select()
          .from(departments)
          .where(eq(departments.id, input.departmentId))
          .limit(1);
        if (!dept) {
          throw new NotFoundException({
            code: 'DEPARTMENT_NOT_FOUND',
            message: 'Département de rattachement introuvable dans cette entreprise.',
          });
        }
        if (dept.siteId) {
          this.assertSiteScope(principal, 'employees.manage', dept.siteId);
        } else if (!hasAllSitesForPermission(principal, 'employees.manage')) {
          throw new ForbiddenException({
            code: 'SITE_SCOPE_DENIED',
            message: 'Votre périmètre ne permet pas de créer un poste sur un département global.',
          });
        }
      } else if (!hasAllSitesForPermission(principal, 'employees.manage')) {
        throw new ForbiddenException({
          code: 'ALL_SITES_SCOPE_REQUIRED',
          message:
            'La création d’un poste transverse exige la permission employees.manage sur ALL_SITES.',
        });
      }

      const [dup] = await tx
        .select({ id: jobPositions.id })
        .from(jobPositions)
        .where(and(eq(jobPositions.tenantId, tenantId), eq(jobPositions.code, input.code)))
        .limit(1);
      if (dup) {
        throw new ConflictException({
          code: 'JOB_POSITION_CODE_EXISTS',
          message: `Le code poste "${input.code}" existe déjà dans cette entreprise.`,
        });
      }

      const positionId = uuidv7();
      const [inserted] = await tx
        .insert(jobPositions)
        .values({
          id: positionId,
          tenantId,
          departmentId: input.departmentId ?? null,
          code: input.code,
          title: input.title,
          professionalCategory: input.professionalCategory,
          status: 'ACTIVE',
        })
        .returning();

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'JOB_POSITION_CREATED',
        resourceType: 'job_position',
        resourceId: positionId,
        afterState: inserted,
      });

      return inserted!;
    });
  }

  // ==========================================================================
  // 2. Dossiers Employés RDC (matricule atomique + enveloppe AES-256-GCM)
  // ==========================================================================

  async listEmployees(
    principal: AuthenticatedPrincipal,
    filters: { siteId?: string; status?: string; search?: string },
  ) {
    const tenantId = principal.activeTenantId!;
    const readScope = getPermissionScope(principal, 'employees.read');

    if (filters.siteId && readScope && !readScope.allSites) {
      const canFilterSite =
        readScope.siteIds.has(filters.siteId) || readScope.contextSiteIds.has(filters.siteId);
      if (!canFilterSite) {
        throw new ForbiddenException({
          code: 'SITE_SCOPE_DENIED',
          message: 'Accès refusé : cet établissement est en dehors de votre périmètre autorisé.',
        });
      }
    }

    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      if (!readScope) {
        return [];
      }

      const conditions = [eq(employees.tenantId, tenantId)];

      // C-02 / C-06 : Application stricte du périmètre propre à `employees.read`
      // (ALL_SITES, SELECTED_SITES, OWN_DEPARTMENT, SELF_ONLY — fail-closed si aucun périmètre actif)
      if (!readScope.allSites) {
        const scopeDisjuncts = [];
        if (readScope.siteIds.size > 0) {
          scopeDisjuncts.push(inArray(employees.primarySiteId, Array.from(readScope.siteIds)));
        }
        if (readScope.departmentIds.size > 0) {
          scopeDisjuncts.push(
            inArray(employees.departmentId, Array.from(readScope.departmentIds)),
          );
        }
        if (readScope.selfEmployeeId) {
          scopeDisjuncts.push(eq(employees.id, readScope.selfEmployeeId));
        }
        if (scopeDisjuncts.length === 0) {
          return [];
        }
        conditions.push(
          scopeDisjuncts.length === 1 ? scopeDisjuncts[0]! : or(...scopeDisjuncts)!,
        );
      }

      if (filters.siteId) {
        conditions.push(eq(employees.primarySiteId, filters.siteId));
      }
      if (filters.status) {
        conditions.push(eq(employees.status, filters.status));
      }

      const rows = await tx
        .select()
        .from(employees)
        .where(and(...conditions))
        .orderBy(asc(employees.lastName), asc(employees.firstName));

      const term = filters.search?.trim().toLowerCase();
      const filtered = term
        ? rows.filter(
            (r) =>
              r.matricule.toLowerCase().includes(term) ||
              r.lastName.toLowerCase().includes(term) ||
              (r.postName?.toLowerCase().includes(term) ?? false) ||
              r.firstName.toLowerCase().includes(term),
          )
        : rows;

      return filtered.map((r) => this.sanitizeEmployee(r));
    });
  }

  async createEmployee(
    principal: AuthenticatedPrincipal,
    input: CreateEmployeeInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    this.assertSiteScope(principal, 'employees.manage', input.primarySiteId);

    // Saisie de coordonnées bancaires/Mobile Money exige employees.salary.manage sur cet établissement (C-02)
    if (input.bankAccountNumber || input.mobileMoneyNumber) {
      if (!principal.permissions.has('employees.salary.manage')) {
        throw new ForbiddenException({
          code: 'SALARY_MANAGE_PERMISSION_REQUIRED',
          message:
            'La permission employees.salary.manage est requise pour enregistrer des coordonnées bancaires ou Mobile Money.',
        });
      }
      this.assertSiteScope(principal, 'employees.salary.manage', input.primarySiteId);
    }

    const tenantCtx = await this.loadTenantContext(tenantId);
    const employeeId = uuidv7();
    const outboxId = uuidv7();

    // Chiffrement par enveloppe AES-256-GCM des identifiants sensibles RDC (AAD lié au tenant + employé)
    const piiPayload: DecryptedPiiPayload = {
      identityDocNumber: input.identityDocNumber ?? null,
      cnssNumber: input.cnssNumber ?? null,
      individualTaxId: input.individualTaxId ?? null,
    };
    const hasAnyPii = Boolean(
      piiPayload.identityDocNumber || piiPayload.cnssNumber || piiPayload.individualTaxId,
    );
    const encryptedPii = hasAnyPii
      ? encryptEnvelope(this.config.security.masterKek, JSON.stringify(piiPayload), {
          tenantScope: tenantId,
          keyRef: tenantCtx.encryptionKeyRef,
          purpose: 'employee_pii',
          recordId: employeeId,
        })
      : null;

    const cnssBlindIndex = input.cnssNumber
      ? computeTenantBlindIndex(
          this.config.security.masterKek,
          tenantId,
          tenantCtx.encryptionKeyRef,
          'cnss_number',
          input.cnssNumber,
        )
      : null;

    const identityDocBlindIndex = input.identityDocNumber
      ? computeTenantBlindIndex(
          this.config.security.masterKek,
          tenantId,
          tenantCtx.encryptionKeyRef,
          'identity_doc_number',
          `${input.identityDocType ?? 'DOC'}:${input.identityDocNumber}`,
        )
      : null;

    // Chiffrement par enveloppe AES-256-GCM des coordonnées de paiement
    const paymentPayload: DecryptedPaymentPayload = {
      bankAccountNumber: input.bankAccountNumber ?? null,
      mobileMoneyNumber: input.mobileMoneyNumber ?? null,
    };
    const hasAnyPayment = Boolean(
      paymentPayload.bankAccountNumber || paymentPayload.mobileMoneyNumber,
    );
    const encryptedPayment = hasAnyPayment
      ? encryptEnvelope(this.config.security.masterKek, JSON.stringify(paymentPayload), {
          tenantScope: tenantId,
          keyRef: tenantCtx.encryptionKeyRef,
          purpose: 'employee_payment',
          recordId: employeeId,
        })
      : null;

    const created = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const [site] = await tx
        .select()
        .from(sites)
        .where(and(eq(sites.id, input.primarySiteId), eq(sites.status, 'ACTIVE')))
        .limit(1);
      if (!site) {
        throw new NotFoundException({
          code: 'SITE_NOT_FOUND',
          message: 'Établissement d’affectation introuvable ou inactif dans cette entreprise.',
        });
      }

      await this.assertValidOrgRefs(tx, {
        departmentId: input.departmentId ?? null,
        jobPositionId: input.jobPositionId ?? null,
        managerEmployeeId: input.managerEmployeeId ?? null,
        siteId: site.id,
      });

      // Détection anti-doublon CNSS et pièce d'identité par index aveugle HMAC (sans texte clair)
      if (cnssBlindIndex) {
        const [dupCnss] = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(and(eq(employees.tenantId, tenantId), eq(employees.cnssBlindIndex, cnssBlindIndex)))
          .limit(1);
        if (dupCnss) {
          throw new ConflictException({
            code: 'EMPLOYEE_CNSS_DUPLICATE',
            message: 'Un dossier agent possède déjà ce numéro d’immatriculation CNSS dans cette entreprise.',
          });
        }
      }

      if (identityDocBlindIndex) {
        const [dupDoc] = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, tenantId),
              eq(employees.identityDocBlindIndex, identityDocBlindIndex),
            ),
          )
          .limit(1);
        if (dupDoc) {
          throw new ConflictException({
            code: 'EMPLOYEE_IDENTITY_DOC_DUPLICATE',
            message: 'Un dossier agent possède déjà ce numéro de pièce d’identité dans cette entreprise.',
          });
        }
      }

      // Allocation strictement atomique du matricule unique dans la transaction RLS
      const matricule = await this.db.allocateAtomicMatricule(tx, {
        tenantId,
        pattern: tenantCtx.matriculePattern,
        siteCode: site.code,
        tenantSlug: tenantCtx.slug,
        hireDate: input.hireDate,
      });

      const [inserted] = await tx
        .insert(employees)
        .values({
          id: employeeId,
          tenantId,
          matricule,
          primarySiteId: site.id,
          departmentId: input.departmentId ?? null,
          jobPositionId: input.jobPositionId ?? null,
          managerEmployeeId: input.managerEmployeeId ?? null,
          lastName: input.lastName.toUpperCase(),
          postName: input.postName ? input.postName.toUpperCase() : null,
          firstName: input.firstName,
          gender: input.gender,
          birthDate: input.birthDate,
          birthPlace: input.birthPlace ?? null,
          nationalityCode: input.nationalityCode,
          isExpatriate: input.isExpatriate ?? null,
          maritalStatus: input.maritalStatus,
          taxDependentsCount: 0,
          hireDate: input.hireDate,
          workEmail: input.workEmail ?? null,
          phonePrimary: input.phonePrimary ?? null,
          province: input.province ?? site.province,
          city: input.city ?? site.city,
          commune: input.commune ?? null,
          addressLine: input.addressLine ?? null,
          emergencyContactName: input.emergencyContactName ?? null,
          emergencyContactPhone: input.emergencyContactPhone ?? null,
          identityDocType: input.identityDocType ?? null,
          identityDocMasked: input.identityDocNumber
            ? maskSensitiveValue(input.identityDocNumber, 4)
            : null,
          identityDocExpiresAt: input.identityDocExpiresAt ?? null,
          cnssNumberMasked: input.cnssNumber ? maskSensitiveValue(input.cnssNumber, 4) : null,
          individualTaxIdMasked: input.individualTaxId
            ? maskSensitiveValue(input.individualTaxId, 4)
            : null,
          encryptedPii,
          cnssBlindIndex,
          identityDocBlindIndex,
          paymentMethod: input.paymentMethod,
          bankName: input.bankName ?? null,
          bankAccountMasked: input.bankAccountNumber
            ? maskSensitiveValue(input.bankAccountNumber, 4)
            : null,
          mobileMoneyOperator: input.mobileMoneyOperator ?? null,
          mobileMoneyMasked: input.mobileMoneyNumber
            ? maskSensitiveValue(input.mobileMoneyNumber, 3)
            : null,
          encryptedPayment,
          // Aucun consentement précoché -> mode non-biométrique QR+PIN par défaut strict
          attendanceMode: 'QR_PIN_ONLY',
          status: input.status,
          createdBy: principal.userId,
        })
        .returning();

      await tx.insert(outboxEvents).values({
        id: outboxId,
        tenantId,
        exchange: 'nexus.employees',
        routingKey: 'employee.created',
        payload: {
          employeeId,
          matricule,
          primarySiteId: site.id,
          attendanceMode: 'QR_PIN_ONLY',
          status: input.status,
        },
        status: 'PENDING',
      });

      const safe = this.sanitizeEmployee(inserted!);

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_CREATED',
        resourceType: 'employee',
        resourceId: employeeId,
        siteId: site.id,
        afterState: {
          matricule: safe.matricule,
          lastName: safe.lastName,
          postName: safe.postName,
          firstName: safe.firstName,
          primarySiteId: safe.primarySiteId,
          hireDate: safe.hireDate,
          attendanceMode: safe.attendanceMode,
          status: safe.status,
          piiEncrypted: hasAnyPii,
          paymentEncrypted: hasAnyPayment,
        },
      });

      return safe;
    });

    await this.relayOutboxBestEffort(tenantId, outboxId, 'nexus.employees', 'employee.created', {
      employeeId,
      matricule: created.matricule,
      primarySiteId: created.primarySiteId,
    });

    return created;
  }

  async getEmployee(principal: AuthenticatedPrincipal, employeeId: string) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(tx, principal, employeeId, 'employees.read');
      return this.sanitizeEmployee(emp);
    });
  }

  async updateEmployee(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    input: UpdateEmployeeInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;

    if (input.primarySiteId) {
      this.assertSiteScope(principal, 'employees.manage', input.primarySiteId);
    }
    const modifiesPayment =
      input.bankAccountNumber !== undefined ||
      input.mobileMoneyNumber !== undefined ||
      input.paymentMethod !== undefined ||
      input.bankName !== undefined ||
      input.mobileMoneyOperator !== undefined;
    if (modifiesPayment && !principal.permissions.has('employees.salary.manage')) {
      throw new ForbiddenException({
        code: 'SALARY_MANAGE_PERMISSION_REQUIRED',
        message:
          'La permission employees.salary.manage est requise pour modifier les coordonnées de paiement.',
      });
    }

    const tenantCtx = await this.loadTenantContext(tenantId);

    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const existing = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.manage',
      );
      if (modifiesPayment) {
        if (!canAccessEmployeeForPermission(principal, 'employees.salary.manage', existing)) {
          throw new ForbiddenException({
            code: 'SITE_SCOPE_DENIED',
            message:
              'Votre périmètre pour employees.salary.manage ne couvre pas ce dossier agent.',
          });
        }
        if (input.primarySiteId) {
          this.assertSiteScope(principal, 'employees.salary.manage', input.primarySiteId);
        }
      }
      const targetSiteId = input.primarySiteId ?? existing.primarySiteId;

      if (input.primarySiteId && input.primarySiteId !== existing.primarySiteId) {
        const [site] = await tx
          .select()
          .from(sites)
          .where(and(eq(sites.id, input.primarySiteId), eq(sites.status, 'ACTIVE')))
          .limit(1);
        if (!site) {
          throw new NotFoundException({
            code: 'SITE_NOT_FOUND',
            message: 'Nouvel établissement introuvable ou inactif.',
          });
        }
      }

      if (input.managerEmployeeId === employeeId) {
        throw new BadRequestException({
          code: 'INVALID_SELF_MANAGER',
          message: 'Un employé ne peut pas être son propre supérieur hiérarchique.',
        });
      }

      await this.assertValidOrgRefs(tx, {
        departmentId: input.departmentId !== undefined ? input.departmentId : existing.departmentId,
        jobPositionId:
          input.jobPositionId !== undefined ? input.jobPositionId : existing.jobPositionId,
        managerEmployeeId:
          input.managerEmployeeId !== undefined
            ? input.managerEmployeeId
            : existing.managerEmployeeId,
        siteId: targetSiteId,
      });

      // Fusion chiffrée des PII si l'un des champs PII est modifié
      let nextEncryptedPii = existing.encryptedPii;
      let nextIdentityDocType =
        input.identityDocType !== undefined ? input.identityDocType : existing.identityDocType;
      let nextIdentityDocMasked = existing.identityDocMasked;
      let nextCnssMasked = existing.cnssNumberMasked;
      let nextTaxMasked = existing.individualTaxIdMasked;
      let nextCnssBlind = existing.cnssBlindIndex;
      let nextIdBlind = existing.identityDocBlindIndex;

      if (
        input.identityDocNumber !== undefined ||
        input.cnssNumber !== undefined ||
        input.individualTaxId !== undefined
      ) {
        const currentPii = this.decryptPiiOrEmpty(existing, tenantId, tenantCtx.encryptionKeyRef);
        const mergedPii: DecryptedPiiPayload = {
          identityDocNumber:
            input.identityDocNumber !== undefined
              ? input.identityDocNumber
              : currentPii.identityDocNumber,
          cnssNumber: input.cnssNumber !== undefined ? input.cnssNumber : currentPii.cnssNumber,
          individualTaxId:
            input.individualTaxId !== undefined
              ? input.individualTaxId
              : currentPii.individualTaxId,
        };

        nextIdentityDocMasked = mergedPii.identityDocNumber
          ? maskSensitiveValue(mergedPii.identityDocNumber, 4)
          : null;
        if (!mergedPii.identityDocNumber && input.identityDocType === undefined) {
          nextIdentityDocType = existing.identityDocType;
        }
        nextCnssMasked = mergedPii.cnssNumber ? maskSensitiveValue(mergedPii.cnssNumber, 4) : null;
        nextTaxMasked = mergedPii.individualTaxId
          ? maskSensitiveValue(mergedPii.individualTaxId, 4)
          : null;

        nextCnssBlind = mergedPii.cnssNumber
          ? computeTenantBlindIndex(
              this.config.security.masterKek,
              tenantId,
              tenantCtx.encryptionKeyRef,
              'cnss_number',
              mergedPii.cnssNumber,
            )
          : null;

        nextIdBlind = mergedPii.identityDocNumber
          ? computeTenantBlindIndex(
              this.config.security.masterKek,
              tenantId,
              tenantCtx.encryptionKeyRef,
              'identity_doc_number',
              `${nextIdentityDocType ?? 'DOC'}:${mergedPii.identityDocNumber}`,
            )
          : null;

        if (nextCnssBlind && nextCnssBlind !== existing.cnssBlindIndex) {
          const [dup] = await tx
            .select({ id: employees.id })
            .from(employees)
            .where(and(eq(employees.tenantId, tenantId), eq(employees.cnssBlindIndex, nextCnssBlind)))
            .limit(1);
          if (dup && dup.id !== employeeId) {
            throw new ConflictException({
              code: 'EMPLOYEE_CNSS_DUPLICATE',
              message: 'Ce numéro CNSS est déjà attribué à un autre agent de l’entreprise.',
            });
          }
        }

        if (nextIdBlind && nextIdBlind !== existing.identityDocBlindIndex) {
          const [dup] = await tx
            .select({ id: employees.id })
            .from(employees)
            .where(
              and(eq(employees.tenantId, tenantId), eq(employees.identityDocBlindIndex, nextIdBlind)),
            )
            .limit(1);
          if (dup && dup.id !== employeeId) {
            throw new ConflictException({
              code: 'EMPLOYEE_IDENTITY_DOC_DUPLICATE',
              message: 'Ce numéro de pièce d’identité est déjà attribué à un autre agent.',
            });
          }
        }

        const anyPii = Boolean(
          mergedPii.identityDocNumber || mergedPii.cnssNumber || mergedPii.individualTaxId,
        );
        nextEncryptedPii = anyPii
          ? encryptEnvelope(this.config.security.masterKek, JSON.stringify(mergedPii), {
              tenantScope: tenantId,
              keyRef: tenantCtx.encryptionKeyRef,
              purpose: 'employee_pii',
              recordId: employeeId,
            })
          : null;
      }

      // Fusion chiffrée des coordonnées de paiement
      let nextEncryptedPayment = existing.encryptedPayment;
      let nextBankMasked = existing.bankAccountMasked;
      let nextMomoMasked = existing.mobileMoneyMasked;

      if (input.bankAccountNumber !== undefined || input.mobileMoneyNumber !== undefined) {
        const currentPay = this.decryptPaymentOrEmpty(
          existing,
          tenantId,
          tenantCtx.encryptionKeyRef,
        );
        const mergedPay: DecryptedPaymentPayload = {
          bankAccountNumber:
            input.bankAccountNumber !== undefined
              ? input.bankAccountNumber
              : currentPay.bankAccountNumber,
          mobileMoneyNumber:
            input.mobileMoneyNumber !== undefined
              ? input.mobileMoneyNumber
              : currentPay.mobileMoneyNumber,
        };
        nextBankMasked = mergedPay.bankAccountNumber
          ? maskSensitiveValue(mergedPay.bankAccountNumber, 4)
          : null;
        nextMomoMasked = mergedPay.mobileMoneyNumber
          ? maskSensitiveValue(mergedPay.mobileMoneyNumber, 3)
          : null;
        const anyPay = Boolean(mergedPay.bankAccountNumber || mergedPay.mobileMoneyNumber);
        nextEncryptedPayment = anyPay
          ? encryptEnvelope(this.config.security.masterKek, JSON.stringify(mergedPay), {
              tenantScope: tenantId,
              keyRef: tenantCtx.encryptionKeyRef,
              purpose: 'employee_payment',
              recordId: employeeId,
            })
          : null;
      }

      const nextIdentityDocExpiresAt =
        input.identityDocExpiresAt !== undefined
          ? input.identityDocExpiresAt
          : nextIdentityDocType === null
            ? null
            : existing.identityDocExpiresAt;

      if (nextIdentityDocExpiresAt && !nextIdentityDocType) {
        throw new BadRequestException({
          code: 'IDENTITY_DOC_TYPE_REQUIRED',
          message:
            'Le type de pièce ou titre est obligatoire lorsqu’une date d’expiration est renseignée.',
        });
      }
      if (nextIdentityDocExpiresAt && nextIdentityDocExpiresAt <= existing.birthDate) {
        throw new BadRequestException({
          code: 'IDENTITY_DOC_EXPIRY_INVALID',
          message:
            'La date d’expiration de la pièce ou du titre doit être postérieure à la date de naissance.',
        });
      }

      const [updated] = await tx
        .update(employees)
        .set({
          primarySiteId: targetSiteId,
          ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
          ...(input.jobPositionId !== undefined ? { jobPositionId: input.jobPositionId } : {}),
          ...(input.managerEmployeeId !== undefined
            ? { managerEmployeeId: input.managerEmployeeId }
            : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName.toUpperCase() } : {}),
          ...(input.postName !== undefined
            ? { postName: input.postName ? input.postName.toUpperCase() : null }
            : {}),
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.isExpatriate !== undefined ? { isExpatriate: input.isExpatriate } : {}),
          ...(input.maritalStatus !== undefined ? { maritalStatus: input.maritalStatus } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.terminationDate !== undefined ? { terminationDate: input.terminationDate } : {}),
          ...(input.terminationReason !== undefined
            ? { terminationReason: input.terminationReason }
            : {}),
          ...(input.workEmail !== undefined ? { workEmail: input.workEmail } : {}),
          ...(input.phonePrimary !== undefined ? { phonePrimary: input.phonePrimary } : {}),
          ...(input.province !== undefined ? { province: input.province } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.commune !== undefined ? { commune: input.commune } : {}),
          ...(input.addressLine !== undefined ? { addressLine: input.addressLine } : {}),
          ...(input.emergencyContactName !== undefined
            ? { emergencyContactName: input.emergencyContactName }
            : {}),
          ...(input.emergencyContactPhone !== undefined
            ? { emergencyContactPhone: input.emergencyContactPhone }
            : {}),
          identityDocType: nextIdentityDocType,
          identityDocMasked: nextIdentityDocMasked,
          identityDocExpiresAt: nextIdentityDocExpiresAt,
          cnssNumberMasked: nextCnssMasked,
          individualTaxIdMasked: nextTaxMasked,
          encryptedPii: nextEncryptedPii,
          cnssBlindIndex: nextCnssBlind,
          identityDocBlindIndex: nextIdBlind,
          ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
          ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
          bankAccountMasked: nextBankMasked,
          ...(input.mobileMoneyOperator !== undefined
            ? { mobileMoneyOperator: input.mobileMoneyOperator }
            : {}),
          mobileMoneyMasked: nextMomoMasked,
          encryptedPayment: nextEncryptedPayment,
          updatedAt: new Date(),
        })
        .where(and(eq(employees.id, employeeId), eq(employees.tenantId, tenantId)))
        .returning();

      // Si fin de service (TERMINATED), révoquer immédiatement tout badge QR+PIN actif et clôturer le contrat actif
      if (input.status === 'TERMINATED' && existing.status !== 'TERMINATED') {
        await tx
          .update(employeeAttendanceBadges)
          .set({
            status: 'REVOKED',
            revokedBy: principal.userId,
            revokedAt: new Date(),
            revokeReason: 'Révocation automatique suite à fin de service de l’agent.',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(employeeAttendanceBadges.tenantId, tenantId),
              eq(employeeAttendanceBadges.employeeId, employeeId),
              eq(employeeAttendanceBadges.status, 'ACTIVE'),
            ),
          );

        await tx
          .update(employmentContracts)
          .set({
            status: 'TERMINATED',
            statusReason: input.terminationReason ?? 'Fin de service de l’agent.',
            terminatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(employmentContracts.tenantId, tenantId),
              eq(employmentContracts.employeeId, employeeId),
              eq(employmentContracts.status, 'ACTIVE'),
            ),
          );
      }

      const safeBefore = this.sanitizeEmployee(existing);
      const safeAfter = this.sanitizeEmployee(updated!);

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: input.status === 'TERMINATED' ? 'EMPLOYEE_TERMINATED' : 'EMPLOYEE_UPDATED',
        resourceType: 'employee',
        resourceId: employeeId,
        siteId: targetSiteId,
        reason: input.terminationReason ?? null,
        beforeState: {
          status: safeBefore.status,
          primarySiteId: safeBefore.primarySiteId,
          maritalStatus: safeBefore.maritalStatus,
        },
        afterState: {
          status: safeAfter.status,
          primarySiteId: safeAfter.primarySiteId,
          maritalStatus: safeAfter.maritalStatus,
        },
      });

      return safeAfter;
    });
  }

  /**
   * Déchiffrement ponctuel et obligatoirement journalisé (SHA-256) des identifiants RDC
   * sensibles d'un employé (principe de minimisation — Ordonnance-Loi RDC n° 23/010).
   */
  async revealEmployeeSensitiveData(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    const tenantCtx = await this.loadTenantContext(tenantId);

    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.pii.read',
      );
      const canReadPayment = canAccessEmployeeForPermission(
        principal,
        'employees.salary.read',
        emp,
      );
      const pii = this.decryptPiiOrEmpty(emp, tenantId, tenantCtx.encryptionKeyRef);
      const payment = canReadPayment
        ? this.decryptPaymentOrEmpty(emp, tenantId, tenantCtx.encryptionKeyRef)
        : null;

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_SENSITIVE_PII_ACCESSED',
        resourceType: 'employee',
        resourceId: employeeId,
        siteId: emp.primarySiteId,
        afterState: {
          matricule: emp.matricule,
          includedPaymentDetails: canReadPayment,
        },
      });

      return {
        employeeId: emp.id,
        matricule: emp.matricule,
        identityDocType: emp.identityDocType,
        identityDocNumber: pii.identityDocNumber,
        cnssNumber: pii.cnssNumber,
        individualTaxId: pii.individualTaxId,
        payment: canReadPayment
          ? {
              paymentMethod: emp.paymentMethod,
              bankName: emp.bankName,
              bankAccountNumber: payment?.bankAccountNumber ?? null,
              mobileMoneyOperator: emp.mobileMoneyOperator,
              mobileMoneyNumber: payment?.mobileMoneyNumber ?? null,
            }
          : null,
      };
    });
  }

  // ==========================================================================
  // 3. Famille & Ayants droit RDC
  // ==========================================================================

  async listDependents(principal: AuthenticatedPrincipal, employeeId: string) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      await this.requireAccessibleEmployee(tx, principal, employeeId, 'employees.read');
      return tx
        .select()
        .from(employeeDependents)
        .where(
          and(
            eq(employeeDependents.tenantId, tenantId),
            eq(employeeDependents.employeeId, employeeId),
            eq(employeeDependents.status, 'ACTIVE'),
          ),
        )
        .orderBy(asc(employeeDependents.createdAt));
    });
  }

  async addDependent(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    input: CreateDependentInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.manage',
      );
      const depId = uuidv7();
      const [inserted] = await tx
        .insert(employeeDependents)
        .values({
          id: depId,
          tenantId,
          employeeId,
          fullName: input.fullName,
          relationship: input.relationship,
          birthDate: input.birthDate ?? null,
          isTaxDependent: input.isTaxDependent,
          isPfBeneficiary: input.isPfBeneficiary,
          notes: input.notes ?? null,
          status: 'ACTIVE',
        })
        .returning();

      const newTaxCount = await this.recomputeTaxDependents(tx, tenantId, employeeId);

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_DEPENDENT_ADDED',
        resourceType: 'employee_dependent',
        resourceId: depId,
        siteId: emp.primarySiteId,
        afterState: {
          employeeId,
          relationship: input.relationship,
          isTaxDependent: input.isTaxDependent,
          taxDependentsCount: newTaxCount,
        },
      });

      return { dependent: inserted!, taxDependentsCount: newTaxCount };
    });
  }

  async archiveDependent(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    dependentId: string,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.manage',
      );
      const [existing] = await tx
        .select()
        .from(employeeDependents)
        .where(
          and(
            eq(employeeDependents.id, dependentId),
            eq(employeeDependents.employeeId, employeeId),
            eq(employeeDependents.tenantId, tenantId),
            eq(employeeDependents.status, 'ACTIVE'),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new NotFoundException({
          code: 'DEPENDENT_NOT_FOUND',
          message: 'Ayant droit introuvable sur ce dossier agent.',
        });
      }

      await tx
        .update(employeeDependents)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(eq(employeeDependents.id, dependentId));

      const newTaxCount = await this.recomputeTaxDependents(tx, tenantId, employeeId);

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_DEPENDENT_ARCHIVED',
        resourceType: 'employee_dependent',
        resourceId: dependentId,
        siteId: emp.primarySiteId,
        afterState: { employeeId, status: 'ARCHIVED', taxDependentsCount: newTaxCount },
      });

      return { archived: true, taxDependentsCount: newTaxCount };
    });
  }

  // ==========================================================================
  // 4. Contrats de travail RDC (salaire chiffré AES-256-GCM + contrôle ONEM/CDD)
  // ==========================================================================

  async listContracts(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    meta?: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    const hasSalaryPerm = principal.permissions.has('employees.salary.read');
    const tenantCtx = hasSalaryPerm ? await this.loadTenantContext(tenantId) : null;

    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'contracts.read',
      );
      // C-02 : Vérifie que `employees.salary.read` couvre effectivement CE dossier agent
      const canReadSalary = canAccessEmployeeForPermission(
        principal,
        'employees.salary.read',
        emp,
      );
      const rows = await tx
        .select()
        .from(employmentContracts)
        .where(
          and(
            eq(employmentContracts.tenantId, tenantId),
            eq(employmentContracts.employeeId, employeeId),
          ),
        )
        .orderBy(desc(employmentContracts.startDate), desc(employmentContracts.createdAt));

      const formatted = rows.map((row) =>
        this.formatContract(row, tenantId, tenantCtx?.encryptionKeyRef ?? null, canReadSalary),
      );

      // C-06 : Journalisation immuable de tout déchiffrement effectif de salaires contractuels
      // (aucun montant en clair n'est inscrit dans `audit_logs`).
      if (canReadSalary && rows.length > 0) {
        await this.db.appendAuditLog(tx, {
          tenantId,
          actorType: this.actorType(principal),
          actorId: principal.userId,
          actorEmail: principal.email,
          actorRole: principal.roleCodes.join(','),
          ipAddress: meta?.ipAddress ?? 'unknown',
          userAgent: meta?.userAgent ?? 'unknown',
          requestId: meta?.requestId ?? 'unknown',
          action: 'EMPLOYEE_SALARY_ACCESSED',
          resourceType: 'employee',
          resourceId: emp.id,
          siteId: emp.primarySiteId,
          afterState: {
            matricule: emp.matricule,
            decryptedContractCount: rows.length,
          },
        });
      }

      return formatted;
    });
  }

  async createContract(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    input: CreateContractInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    this.assertSiteScope(principal, 'contracts.manage', input.siteId);

    if (!principal.permissions.has('employees.salary.manage')) {
      throw new ForbiddenException({
        code: 'SALARY_MANAGE_PERMISSION_REQUIRED',
        message:
          'La permission employees.salary.manage est obligatoire pour fixer la rémunération contractuelle.',
      });
    }
    this.assertSiteScope(principal, 'employees.salary.manage', input.siteId);

    const tenantCtx = await this.loadTenantContext(tenantId);
    const contractId = uuidv7();
    const encryptedBaseSalary = encryptEnvelope(
      this.config.security.masterKek,
      JSON.stringify({ baseSalary: input.baseSalary }),
      {
        tenantScope: tenantId,
        keyRef: tenantCtx.encryptionKeyRef,
        purpose: 'employee_salary',
        recordId: contractId,
      },
    );

    const advisories = this.computeDrcContractAdvisories(input);

    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'contracts.manage',
      );
      if (!canAccessEmployeeForPermission(principal, 'employees.salary.manage', emp)) {
        throw new ForbiddenException({
          code: 'SITE_SCOPE_DENIED',
          message:
            'Votre périmètre pour employees.salary.manage ne couvre pas ce dossier agent.',
        });
      }
      if (emp.status === 'TERMINATED') {
        throw new ConflictException({
          code: 'EMPLOYEE_TERMINATED',
          message: 'Impossible de créer un contrat actif sur un dossier agent clôturé.',
        });
      }

      const [site] = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, input.siteId), eq(sites.status, 'ACTIVE')))
        .limit(1);
      if (!site) {
        throw new NotFoundException({
          code: 'SITE_NOT_FOUND',
          message: 'Établissement d’exécution du contrat introuvable ou inactif.',
        });
      }

      if (input.jobPositionId) {
        const [pos] = await tx
          .select({ id: jobPositions.id })
          .from(jobPositions)
          .where(eq(jobPositions.id, input.jobPositionId))
          .limit(1);
        if (!pos) {
          throw new NotFoundException({
            code: 'JOB_POSITION_NOT_FOUND',
            message: 'Poste contractuel introuvable dans cette entreprise.',
          });
        }
      }

      if (input.signedDocumentId) {
        await this.assertEmployeeDocumentActive(tx, tenantId, employeeId, input.signedDocumentId);
      }

      const [dupNumber] = await tx
        .select({ id: employmentContracts.id })
        .from(employmentContracts)
        .where(
          and(
            eq(employmentContracts.tenantId, tenantId),
            eq(employmentContracts.contractNumber, input.contractNumber),
          ),
        )
        .limit(1);
      if (dupNumber) {
        throw new ConflictException({
          code: 'CONTRACT_NUMBER_EXISTS',
          message: `La référence de contrat "${input.contractNumber}" existe déjà dans cette entreprise.`,
        });
      }

      if (input.status === 'ACTIVE') {
        const [existingActive] = await tx
          .select({ id: employmentContracts.id, contractNumber: employmentContracts.contractNumber })
          .from(employmentContracts)
          .where(
            and(
              eq(employmentContracts.tenantId, tenantId),
              eq(employmentContracts.employeeId, employeeId),
              eq(employmentContracts.status, 'ACTIVE'),
            ),
          )
          .limit(1);
        if (existingActive) {
          throw new ConflictException({
            code: 'ACTIVE_CONTRACT_ALREADY_EXISTS',
            message: `Cet agent dispose déjà d’un contrat actif (${existingActive.contractNumber}). Clôturez-le ou suspendez-le avant d’activer un nouveau contrat.`,
          });
        }
      }

      const [inserted] = await tx
        .insert(employmentContracts)
        .values({
          id: contractId,
          tenantId,
          employeeId,
          siteId: input.siteId,
          jobPositionId: input.jobPositionId ?? null,
          contractNumber: input.contractNumber,
          contractType: input.contractType,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          probationEndDate: input.probationEndDate ?? null,
          cddRenewalCount: input.cddRenewalCount,
          weeklyHours: input.weeklyHours.toFixed(2),
          payCurrency: input.payCurrency,
          payFrequency: input.payFrequency,
          encryptedBaseSalary,
          hiringPlace: input.hiringPlace,
          onemVisaRef: input.onemVisaRef ?? null,
          onemVisaDate: input.onemVisaDate ?? null,
          signedDocumentId: input.signedDocumentId ?? null,
          status: input.status,
          createdBy: principal.userId,
        })
        .returning();

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYMENT_CONTRACT_CREATED',
        resourceType: 'employment_contract',
        resourceId: contractId,
        siteId: input.siteId,
        afterState: {
          employeeId,
          contractNumber: input.contractNumber,
          contractType: input.contractType,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          payCurrency: input.payCurrency,
          payFrequency: input.payFrequency,
          cddRenewalCount: input.cddRenewalCount,
          onemVisaRef: input.onemVisaRef ?? null,
          status: input.status,
          salaryEncrypted: true,
        },
      });

      const canReadSalary = canAccessEmployeeForPermission(
        principal,
        'employees.salary.read',
        emp,
      );
      return {
        contract: this.formatContract(
          inserted!,
          tenantId,
          tenantCtx.encryptionKeyRef,
          canReadSalary,
        ),
        complianceAdvisories: advisories,
      };
    });
  }

  async updateContractStatus(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    contractId: string,
    input: UpdateContractStatusInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    const hasSalaryPerm = principal.permissions.has('employees.salary.read');
    const tenantCtx = hasSalaryPerm ? await this.loadTenantContext(tenantId) : null;

    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'contracts.manage',
      );
      const canReadSalary = canAccessEmployeeForPermission(
        principal,
        'employees.salary.read',
        emp,
      );
      const [existing] = await tx
        .select()
        .from(employmentContracts)
        .where(
          and(
            eq(employmentContracts.id, contractId),
            eq(employmentContracts.employeeId, employeeId),
            eq(employmentContracts.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new NotFoundException({
          code: 'CONTRACT_NOT_FOUND',
          message: 'Contrat introuvable sur ce dossier agent.',
        });
      }

      this.assertSiteScope(principal, 'contracts.manage', existing.siteId);

      if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
        const [otherActive] = await tx
          .select({ id: employmentContracts.id })
          .from(employmentContracts)
          .where(
            and(
              eq(employmentContracts.tenantId, tenantId),
              eq(employmentContracts.employeeId, employeeId),
              eq(employmentContracts.status, 'ACTIVE'),
            ),
          )
          .limit(1);
        if (otherActive) {
          throw new ConflictException({
            code: 'ACTIVE_CONTRACT_ALREADY_EXISTS',
            message: 'Un autre contrat est déjà actif pour cet employé.',
          });
        }
      }

      const [updated] = await tx
        .update(employmentContracts)
        .set({
          status: input.status,
          statusReason: input.reason,
          terminatedAt:
            input.status === 'TERMINATED' || input.status === 'EXPIRED'
              ? new Date()
              : existing.terminatedAt,
          updatedAt: new Date(),
        })
        .where(eq(employmentContracts.id, contractId))
        .returning();

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYMENT_CONTRACT_STATUS_UPDATED',
        resourceType: 'employment_contract',
        resourceId: contractId,
        siteId: existing.siteId,
        reason: input.reason,
        beforeState: { status: existing.status },
        afterState: { status: input.status },
      });

      return this.formatContract(
        updated!,
        tenantId,
        tenantCtx?.encryptionKeyRef ?? null,
        canReadSalary,
      );
    });
  }

  // ==========================================================================
  // 5. Badges QR + Code PIN Argon2id (alternative réelle à la biométrie)
  // ==========================================================================

  async listBadges(principal: AuthenticatedPrincipal, employeeId: string) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      await this.requireAccessibleEmployee(tx, principal, employeeId, 'employees.read');
      const rows = await tx
        .select()
        .from(employeeAttendanceBadges)
        .where(
          and(
            eq(employeeAttendanceBadges.tenantId, tenantId),
            eq(employeeAttendanceBadges.employeeId, employeeId),
          ),
        )
        .orderBy(desc(employeeAttendanceBadges.issuedAt));
      return rows.map((b) => this.sanitizeBadge(b));
    });
  }

  async issueBadge(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    input: IssueBadgeInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    const tenantCtx = await this.loadTenantContext(tenantId);

    // Validation de robustesse du PIN (rejette 000000, 123456, 111111, etc.) + Argon2id 64 MiB
    let pinArgon2Hash: string;
    try {
      pinArgon2Hash = await hashPin(input.pin);
    } catch (err) {
      throw new BadRequestException({
        code: 'WEAK_PIN_REJECTED',
        message: err instanceof Error ? err.message : 'Code PIN trop faible.',
      });
    }

    const badgeId = uuidv7();
    const { qrPayload, qrTokenHash } = issueSignedBadgeQrToken({
      masterKek: this.config.security.masterKek,
      tenantId,
      keyRef: tenantCtx.encryptionKeyRef,
      badgeId,
    });

    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.badges.manage',
      );
      if (emp.status !== 'ACTIVE' && emp.status !== 'DRAFT') {
        throw new ConflictException({
          code: 'EMPLOYEE_NOT_ELIGIBLE_FOR_BADGE',
          message: `Impossible d’émettre un badge actif pour un agent au statut ${emp.status}.`,
        });
      }

      // Révoque atomiquement tout badge actif précédent (rotation propre perte/renouvellement)
      const previousActive = await tx
        .update(employeeAttendanceBadges)
        .set({
          status: 'REVOKED',
          revokedBy: principal.userId,
          revokedAt: new Date(),
          revokeReason: input.replaceReason ?? 'Remplacement par émission d’un nouveau badge QR.',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(employeeAttendanceBadges.tenantId, tenantId),
            eq(employeeAttendanceBadges.employeeId, employeeId),
            eq(employeeAttendanceBadges.status, 'ACTIVE'),
          ),
        )
        .returning({ id: employeeAttendanceBadges.id, badgeCode: employeeAttendanceBadges.badgeCode });

      const existingCountRes = await tx
        .select({ count: sql<string>`count(*)::text` })
        .from(employeeAttendanceBadges)
        .where(
          and(
            eq(employeeAttendanceBadges.tenantId, tenantId),
            eq(employeeAttendanceBadges.employeeId, employeeId),
          ),
        );
      const rev = Number(existingCountRes[0]?.count ?? 0) + 1;
      const badgeCode = `BDG-${emp.matricule}-V${rev}`.slice(0, 48);

      const [inserted] = await tx
        .insert(employeeAttendanceBadges)
        .values({
          id: badgeId,
          tenantId,
          employeeId,
          siteId: emp.primarySiteId,
          badgeCode,
          qrTokenHash,
          pinArgon2Hash,
          failedPinAttempts: 0,
          pinLockedUntil: null,
          status: 'ACTIVE',
          issuedBy: principal.userId,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_BADGE_ISSUED',
        resourceType: 'employee_attendance_badge',
        resourceId: badgeId,
        siteId: emp.primarySiteId,
        reason: input.replaceReason ?? null,
        beforeState:
          previousActive.length > 0 ? { replacedBadgeCode: previousActive[0]!.badgeCode } : null,
        afterState: {
          employeeId,
          matricule: emp.matricule,
          badgeCode,
          expiresAt: input.expiresAt ?? null,
          pinAlgorithm: 'Argon2id-64MiB',
          qrSignature: 'HMAC-SHA256',
        },
      });

      return {
        badge: this.sanitizeBadge(inserted!),
        // Affiché UNE SEULE FOIS à l'émission pour impression/remise à l'agent (jamais stocké en clair)
        qrPayloadOnce: qrPayload,
      };
    });
  }

  async rotateBadgePin(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    badgeId: string,
    input: RotateBadgePinInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    let pinArgon2Hash: string;
    try {
      pinArgon2Hash = await hashPin(input.newPin);
    } catch (err) {
      throw new BadRequestException({
        code: 'WEAK_PIN_REJECTED',
        message: err instanceof Error ? err.message : 'Code PIN trop faible.',
      });
    }

    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.badges.manage',
      );
      const [existing] = await tx
        .select()
        .from(employeeAttendanceBadges)
        .where(
          and(
            eq(employeeAttendanceBadges.id, badgeId),
            eq(employeeAttendanceBadges.employeeId, employeeId),
            eq(employeeAttendanceBadges.tenantId, tenantId),
            eq(employeeAttendanceBadges.status, 'ACTIVE'),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new NotFoundException({
          code: 'BADGE_NOT_FOUND',
          message: 'Badge actif introuvable pour cet employé.',
        });
      }

      const [updated] = await tx
        .update(employeeAttendanceBadges)
        .set({
          pinArgon2Hash,
          failedPinAttempts: 0,
          pinLockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(employeeAttendanceBadges.id, badgeId))
        .returning();

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_BADGE_PIN_ROTATED',
        resourceType: 'employee_attendance_badge',
        resourceId: badgeId,
        siteId: emp.primarySiteId,
        reason: input.reason,
        afterState: { employeeId, badgeCode: existing.badgeCode, unlocked: true },
      });

      return this.sanitizeBadge(updated!);
    });
  }

  async revokeBadge(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    badgeId: string,
    input: RevokeBadgeInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.badges.manage',
      );
      const [existing] = await tx
        .select()
        .from(employeeAttendanceBadges)
        .where(
          and(
            eq(employeeAttendanceBadges.id, badgeId),
            eq(employeeAttendanceBadges.employeeId, employeeId),
            eq(employeeAttendanceBadges.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new NotFoundException({
          code: 'BADGE_NOT_FOUND',
          message: 'Badge introuvable pour cet employé.',
        });
      }
      if (existing.status !== 'ACTIVE') {
        throw new ConflictException({
          code: 'BADGE_ALREADY_INACTIVE',
          message: `Ce badge est déjà au statut ${existing.status}.`,
        });
      }

      const [updated] = await tx
        .update(employeeAttendanceBadges)
        .set({
          status: input.status,
          revokedBy: principal.userId,
          revokedAt: new Date(),
          revokeReason: input.reason,
          updatedAt: new Date(),
        })
        .where(eq(employeeAttendanceBadges.id, badgeId))
        .returning();

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_BADGE_REVOKED',
        resourceType: 'employee_attendance_badge',
        resourceId: badgeId,
        siteId: emp.primarySiteId,
        reason: input.reason,
        beforeState: { status: existing.status },
        afterState: { status: input.status, badgeCode: existing.badgeCode },
      });

      return this.sanitizeBadge(updated!);
    });
  }

  /**
   * Vérification réelle de bout en bout d'un badge QR + code PIN Argon2id
   * (garantit une alternative non-biométrique immédiatement fonctionnelle, sans terminal simulé).
   */
  async verifyQrPin(
    principal: AuthenticatedPrincipal,
    input: VerifyQrPinInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    this.assertSiteScope(principal, 'employees.badges.verify', input.siteId);

    const rate = await this.cache.incrementWithWindow(
      `rl:badge-verify:${tenantId}:${meta.ipAddress}`,
      60,
    );
    if (rate.count > 30) {
      throw new HttpException(
        {
          code: 'BADGE_VERIFY_RATE_LIMIT',
          message: `Trop de tentatives de vérification QR/PIN. Réessayez dans ${rate.ttlSeconds} s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const tenantCtx = await this.loadTenantContext(tenantId);
    const qrCheck = verifySignedBadgeQrToken({
      masterKek: this.config.security.masterKek,
      expectedTenantId: tenantId,
      keyRef: tenantCtx.encryptionKeyRef,
      rawQrPayload: input.qrPayload,
    });

    if (!qrCheck.valid) {
      throw new UnauthorizedException({
        code: 'BADGE_QR_INVALID',
        message: 'Badge QR invalide, falsifié ou n’appartenant pas à cette entreprise.',
      });
    }

    // D-02 : Limitation de débit secondaire par badge (indépendante de l'adresse IP)
    const badgeRateKey = `rl:badge-pin:${tenantId}:${qrCheck.badgeId}`;
    const badgeRate = await this.cache.incrementWithWindow(badgeRateKey, 300);
    if (badgeRate.count > 10) {
      throw new HttpException(
        {
          code: 'BADGE_VERIFY_RATE_LIMIT',
          message: `Trop de tentatives sur ce badge. Réessayez dans ${badgeRate.ttlSeconds} s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const outcome = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const [site] = await tx
        .select()
        .from(sites)
        .where(and(eq(sites.id, input.siteId), eq(sites.status, 'ACTIVE')))
        .limit(1);
      if (!site) {
        throw new NotFoundException({
          code: 'SITE_NOT_FOUND',
          message: 'Établissement de vérification introuvable ou inactif.',
        });
      }

      const [badge] = await tx
        .select()
        .from(employeeAttendanceBadges)
        .where(
          and(
            eq(employeeAttendanceBadges.id, qrCheck.badgeId),
            eq(employeeAttendanceBadges.qrTokenHash, qrCheck.qrTokenHash),
            eq(employeeAttendanceBadges.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!badge || badge.status !== 'ACTIVE') {
        throw new UnauthorizedException({
          code: 'BADGE_INACTIVE_OR_REVOKED',
          message: 'Ce badge est révoqué, déclaré perdu ou inactif.',
        });
      }

      const todayIso = new Date().toISOString().slice(0, 10);
      if (badge.expiresAt && badge.expiresAt < todayIso) {
        await tx
          .update(employeeAttendanceBadges)
          .set({ status: 'EXPIRED', updatedAt: new Date() })
          .where(eq(employeeAttendanceBadges.id, badge.id));
        return { kind: 'EXPIRED' as const };
      }

      if (badge.pinLockedUntil && badge.pinLockedUntil.getTime() > Date.now()) {
        return { kind: 'ALREADY_LOCKED' as const };
      }

      const [emp] = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, badge.employeeId), eq(employees.tenantId, tenantId)))
        .limit(1);

      if (!emp || emp.status !== 'ACTIVE') {
        throw new ForbiddenException({
          code: 'EMPLOYEE_NOT_ACTIVE',
          message: 'Le dossier de l’agent associé à ce badge n’est pas actif.',
        });
      }

      // L'agent doit appartenir à l'établissement vérifié
      if (emp.primarySiteId !== site.id) {
        throw new ForbiddenException({
          code: 'EMPLOYEE_SITE_MISMATCH',
          message: 'Ce badge n’est pas rattaché à cet établissement.',
        });
      }

      const pinOk = await verifyPin(badge.pinArgon2Hash, input.pin);
      if (!pinOk) {
        // D-03 : Incrément et verrouillage SQL strictement atomiques (aucune course read-modify-write)
        const now = new Date();
        const lockUntilIso = new Date(
          now.getTime() + BADGE_PIN_LOCKOUT_MINUTES * 60_000,
        ).toISOString();

        const [updatedBadge] = await tx
          .update(employeeAttendanceBadges)
          .set({
            failedPinAttempts: sql`${employeeAttendanceBadges.failedPinAttempts} + 1`,
            pinLockedUntil: sql`CASE WHEN ${employeeAttendanceBadges.failedPinAttempts} + 1 >= ${MAX_BADGE_PIN_FAILURES} THEN ${lockUntilIso}::timestamptz ELSE ${employeeAttendanceBadges.pinLockedUntil} END`,
            updatedAt: now,
          })
          .where(eq(employeeAttendanceBadges.id, badge.id))
          .returning({
            failedPinAttempts: employeeAttendanceBadges.failedPinAttempts,
            pinLockedUntil: employeeAttendanceBadges.pinLockedUntil,
          });

        const nextFailures = updatedBadge?.failedPinAttempts ?? badge.failedPinAttempts + 1;
        const shouldLock = Boolean(
          updatedBadge?.pinLockedUntil && updatedBadge.pinLockedUntil.getTime() > now.getTime(),
        );

        await this.db.appendAuditLog(tx, {
          tenantId,
          actorType: this.actorType(principal),
          actorId: principal.userId,
          actorEmail: principal.email,
          actorRole: principal.roleCodes.join(','),
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          action: shouldLock ? 'BADGE_PIN_LOCKED' : 'BADGE_QR_PIN_VERIFY_FAILED',
          resourceType: 'employee_attendance_badge',
          resourceId: badge.id,
          siteId: site.id,
          afterState: {
            employeeId: emp.id,
            badgeCode: badge.badgeCode,
            failedPinAttempts: nextFailures,
            locked: shouldLock,
          },
        });

        return { kind: 'INVALID_PIN' as const };
      }

      const verifiedAt = new Date();
      const resetRows = await tx
        .update(employeeAttendanceBadges)
        .set({
          failedPinAttempts: 0,
          pinLockedUntil: null,
          lastVerifiedAt: verifiedAt,
          updatedAt: verifiedAt,
        })
        .where(
          and(
            eq(employeeAttendanceBadges.id, badge.id),
            eq(employeeAttendanceBadges.status, 'ACTIVE'),
            or(
              isNull(employeeAttendanceBadges.pinLockedUntil),
              lte(employeeAttendanceBadges.pinLockedUntil, verifiedAt),
            ),
          ),
        )
        .returning({ id: employeeAttendanceBadges.id });
      if (resetRows.length === 0) {
        return {
          kind: 'PIN_LOCKED' as const,
          remainingMin: BADGE_PIN_LOCKOUT_MINUTES,
        };
      }
      await this.cache.del(badgeRateKey);

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'BADGE_QR_PIN_VERIFIED',
        resourceType: 'employee_attendance_badge',
        resourceId: badge.id,
        siteId: site.id,
        afterState: {
          employeeId: emp.id,
          matricule: emp.matricule,
          badgeCode: badge.badgeCode,
          siteCode: site.code,
          timezone: site.timezone,
          method: 'QR_AND_ARGON2ID_PIN',
        },
      });

      return {
        kind: 'VERIFIED' as const,
        payload: {
          verified: true as const,
          method: 'QR_AND_ARGON2ID_PIN' as const,
          verifiedAt: verifiedAt.toISOString(),
          site: {
            id: site.id,
            code: site.code,
            name: site.name,
            timezone: site.timezone,
          },
          employee: {
            id: emp.id,
            matricule: emp.matricule,
            lastName: emp.lastName,
            postName: emp.postName,
            firstName: emp.firstName,
            attendanceMode: emp.attendanceMode,
          },
          badgeCode: badge.badgeCode,
        },
      };
    });

    if (outcome.kind === 'EXPIRED') {
      throw new UnauthorizedException({
        code: 'BADGE_EXPIRED',
        message: 'Ce badge QR est arrivé à expiration.',
      });
    }
    if (outcome.kind === 'ALREADY_LOCKED') {
      throw new HttpException(
        {
          code: 'BADGE_PIN_LOCKED',
          message:
            'Badge temporairement verrouillé après plusieurs codes PIN erronés. Contactez le service RH ou patientez.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (outcome.kind === 'INVALID_PIN') {
      throw new UnauthorizedException({
        code: 'BADGE_PIN_INVALID',
        message: 'Code PIN personnel incorrect.',
      });
    }

    return outcome.payload;
  }

  // ==========================================================================
  // 6. Coffre Documentaire S3 (chiffré AES-256-GCM + intégrité SHA-256)
  // ==========================================================================

  async listDocuments(principal: AuthenticatedPrincipal, employeeId: string) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.documents.read',
      );
      const rows = await tx
        .select()
        .from(employeeDocuments)
        .where(
          and(
            eq(employeeDocuments.tenantId, tenantId),
            eq(employeeDocuments.employeeId, employeeId),
            sql`${employeeDocuments.status} <> 'DELETED'`,
          ),
        )
        .orderBy(desc(employeeDocuments.createdAt));

      // C-05 : Filtrage par catégorie documentaire (contrats -> salary.read, PII/santé -> pii.read, consentements -> consents.read)
      return rows.filter((doc) => this.canReadDocumentCategory(principal, emp, doc.category));
    });
  }

  async uploadDocument(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    input: UploadEmployeeDocumentInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;

    // Décodage Base64 strict et contrôle de taille et de signature binaire (magic bytes)
    const rawBuffer = this.decodeStrictBase64(input.contentBase64);
    if (rawBuffer.length === 0 || rawBuffer.length > MAX_DOCUMENT_SIZE_BYTES) {
      throw new BadRequestException({
        code: 'DOCUMENT_SIZE_INVALID',
        message: `La taille du document doit être comprise entre 1 octet et ${MAX_DOCUMENT_SIZE_BYTES} octets (5 Mo).`,
      });
    }
    this.assertDocumentMagicBytes(rawBuffer, input.mimeType);

    const sha256Checksum = sha256Hex(rawBuffer);
    const tenantCtx = await this.loadTenantContext(tenantId);
    const docId = uuidv7();
    const safeExt = this.extensionForMime(input.mimeType);
    const objectKey = `tenants/${tenantId}/employees/${employeeId}/documents/${docId}.${safeExt}.enc`;

    // Vérifier d'abord l'autorisation RLS + SiteScope + Catégorie documentaire (C-02 / C-05) AVANT toute écriture dans S3
    const emp = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const employee = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.documents.manage',
      );
      this.assertDocumentCategoryWriteAccess(principal, employee, input.category);
      return employee;
    });

    // Chiffrement par enveloppe AES-256-GCM lié à (tenantId, keyRef, 'document_blob', docId)
    const envelope = encryptEnvelope(this.config.security.masterKek, rawBuffer, {
      tenantScope: tenantId,
      keyRef: tenantCtx.encryptionKeyRef,
      purpose: 'document_blob',
      recordId: docId,
    });
    const encryptedPayloadBytes = Buffer.from(JSON.stringify(envelope), 'utf8');

    await this.storage.putObject({
      tenantId,
      objectKey,
      body: encryptedPayloadBytes,
      contentType: 'application/octet-stream',
    });

    try {
      return await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
        const [inserted] = await tx
          .insert(employeeDocuments)
          .values({
            id: docId,
            tenantId,
            employeeId,
            category: input.category,
            title: input.title,
            originalFilename: input.originalFilename,
            mimeType: input.mimeType,
            sizeBytes: rawBuffer.length,
            sha256Checksum,
            storageBucket: this.config.s3.bucket,
            objectKey,
            isEnvelopeEncrypted: true,
            expiresAt: input.expiresAt ?? null,
            retentionUntil: input.retentionUntil ?? null,
            status: 'ACTIVE',
            uploadedBy: principal.userId,
          })
          .returning();

        await this.db.appendAuditLog(tx, {
          tenantId,
          actorType: this.actorType(principal),
          actorId: principal.userId,
          actorEmail: principal.email,
          actorRole: principal.roleCodes.join(','),
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          action: 'EMPLOYEE_DOCUMENT_UPLOADED',
          resourceType: 'employee_document',
          resourceId: docId,
          siteId: emp.primarySiteId,
          afterState: {
            employeeId,
            category: input.category,
            title: input.title,
            mimeType: input.mimeType,
            sizeBytes: rawBuffer.length,
            sha256Checksum,
            isEnvelopeEncrypted: true,
          },
        });

        return inserted!;
      });
    } catch (err) {
      // Nettoyage compensatoire si l'insertion SQL échoue
      await this.storage.deleteObject({ tenantId, objectKey }).catch(() => undefined);
      throw err;
    }
  }

  async downloadDocument(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    documentId: string,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    const tenantCtx = await this.loadTenantContext(tenantId);

    const { emp, doc } = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const employee = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.documents.read',
      );
      const [found] = await tx
        .select()
        .from(employeeDocuments)
        .where(
          and(
            eq(employeeDocuments.id, documentId),
            eq(employeeDocuments.employeeId, employeeId),
            eq(employeeDocuments.tenantId, tenantId),
            sql`${employeeDocuments.status} <> 'DELETED'`,
          ),
        )
        .limit(1);

      if (!found) {
        throw new NotFoundException({
          code: 'DOCUMENT_NOT_FOUND',
          message: 'Document introuvable dans le coffre de cet employé.',
        });
      }

      // C-05 : Vérification stricte de la permission associée à la catégorie documentaire
      this.assertDocumentCategoryReadAccess(principal, employee, found.category);

      return { emp: employee, doc: found };
    });

    const storedBytes = await this.storage.getObject({
      tenantId,
      objectKey: doc.objectKey,
    });

    const envelope = JSON.parse(storedBytes.toString('utf8')) as EnvelopeCiphertext;
    const plaintext = decryptEnvelope(this.config.security.masterKek, envelope, {
      tenantScope: tenantId,
      keyRef: tenantCtx.encryptionKeyRef,
      purpose: 'document_blob',
      recordId: doc.id,
    });

    const recomputedHash = sha256Hex(plaintext);
    if (recomputedHash !== doc.sha256Checksum) {
      throw new ConflictException({
        code: 'DOCUMENT_INTEGRITY_VIOLATION',
        message: 'Alerte sécurité : l’empreinte SHA-256 du document ne correspond pas à l’original.',
      });
    }

    const presignedCiphertextUrl = await this.storage.createPresignedDownloadUrl({
      tenantId,
      objectKey: doc.objectKey,
      expiresInSeconds: 120,
    });

    await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_DOCUMENT_DOWNLOADED',
        resourceType: 'employee_document',
        resourceId: doc.id,
        siteId: emp.primarySiteId,
        afterState: {
          employeeId,
          category: doc.category,
          sha256Verified: true,
        },
      });
    });

    return {
      document: {
        id: doc.id,
        category: doc.category,
        title: doc.title,
        originalFilename: doc.originalFilename,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        sha256Checksum: doc.sha256Checksum,
        sha256Verified: true,
      },
      presignedObjectUrlExpiresInSeconds: 120,
      presignedEncryptedObjectUrl: presignedCiphertextUrl,
      contentBase64: plaintext.toString('base64'),
    };
  }

  async deleteDocument(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    documentId: string,
    input: DeleteEmployeeDocumentInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;

    const doc = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.documents.manage',
      );
      const [found] = await tx
        .select()
        .from(employeeDocuments)
        .where(
          and(
            eq(employeeDocuments.id, documentId),
            eq(employeeDocuments.employeeId, employeeId),
            eq(employeeDocuments.tenantId, tenantId),
            sql`${employeeDocuments.status} <> 'DELETED'`,
          ),
        )
        .limit(1);

      if (!found) {
        throw new NotFoundException({
          code: 'DOCUMENT_NOT_FOUND',
          message: 'Document introuvable ou déjà supprimé.',
        });
      }

      // C-05 : Interdit la suppression d'une pièce sensible (contrat, PII/santé, consentement)
      // par un opérateur non habilité sur cette catégorie.
      this.assertDocumentCategoryWriteAccess(principal, emp, found.category);

      // Protection des preuves légales : interdiction de supprimer une pièce liée à un consentement ou contrat
      const [linkedConsent] = await tx
        .select({ id: employeeConsents.id })
        .from(employeeConsents)
        .where(
          and(
            eq(employeeConsents.tenantId, tenantId),
            eq(employeeConsents.signedDocumentId, documentId),
          ),
        )
        .limit(1);
      if (linkedConsent) {
        throw new ConflictException({
          code: 'DOCUMENT_LOCKED_BY_LEGAL_CONSENT',
          message:
            'Conservation légale : cette pièce justificative est rattachée à un enregistrement de consentement et ne peut pas être supprimée.',
        });
      }

      const [linkedContract] = await tx
        .select({ id: employmentContracts.id })
        .from(employmentContracts)
        .where(
          and(
            eq(employmentContracts.tenantId, tenantId),
            eq(employmentContracts.signedDocumentId, documentId),
          ),
        )
        .limit(1);
      if (linkedContract) {
        throw new ConflictException({
          code: 'DOCUMENT_LOCKED_BY_CONTRACT',
          message:
            'Conservation légale : cette pièce est rattachée à un contrat de travail et ne peut pas être supprimée.',
        });
      }

      await tx
        .update(employeeDocuments)
        .set({
          status: 'DELETED',
          deletedBy: principal.userId,
          deletedAt: new Date(),
          deleteReason: input.reason,
          updatedAt: new Date(),
        })
        .where(eq(employeeDocuments.id, documentId));

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_DOCUMENT_DELETED',
        resourceType: 'employee_document',
        resourceId: documentId,
        siteId: emp.primarySiteId,
        reason: input.reason,
        beforeState: { status: found.status, category: found.category, title: found.title },
        afterState: { status: 'DELETED' },
      });

      return found;
    });

    await this.storage.deleteObject({ tenantId, objectKey: doc.objectKey }).catch(() => undefined);
    return { deleted: true, id: doc.id };
  }

  // ==========================================================================
  // 7. Registre légal des consentements RDC (zéro pré-cochage, révocable)
  // ==========================================================================

  async listConsents(principal: AuthenticatedPrincipal, employeeId: string) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'employees.consents.read',
      );
      return tx
        .select()
        .from(employeeConsents)
        .where(
          and(
            eq(employeeConsents.tenantId, tenantId),
            eq(employeeConsents.employeeId, employeeId),
          ),
        )
        .orderBy(desc(employeeConsents.decidedAt));
    });
  }

  async recordConsent(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    input: RecordEmployeeConsentInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    const tenantCtx = await this.loadTenantContext(tenantId);

    // Garde-fou absolu Décision n° 6 : interdiction de tout consentement au stockage central
    // de gabarits biométriques tant que l'entreprise est en politique DEVICE_ONLY.
    if (
      input.consentType === 'BIOMETRIC_CENTRAL_TEMPLATE' &&
      input.decision === 'GRANTED' &&
      (tenantCtx.biometricStoragePolicy !== 'ENCRYPTED_CENTRAL_SYNC' ||
        !tenantCtx.centralTemplateStorageEnabled)
    ) {
      throw new ForbiddenException({
        code: 'CENTRAL_BIOMETRIC_FORBIDDEN_BY_TENANT_POLICY',
        message:
          'Politique DEVICE_ONLY active : l’enregistrement d’un consentement au stockage central de gabarits biométriques est interdit sans autorisation juridique préalable de l’entreprise.',
      });
    }

    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'biometrics.consent.manage',
      );

      // Verrou transactionnel de ligne sur le dossier salarié (N-01) : sérialise proprement
      // deux enregistrements ou retraits concurrents de consentement sur un même agent, en
      // complément de l'index unique partiel SQL `uq_consents_one_granted_per_type`.
      await tx.execute(
        sql`SELECT id FROM employees WHERE id = ${employeeId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`,
      );

      if (input.signedDocumentId) {
        const doc = await this.assertEmployeeDocumentActive(
          tx,
          tenantId,
          employeeId,
          input.signedDocumentId,
        );
        if (
          (input.consentType === 'BIOMETRIC_DEVICE_ONLY' ||
            input.consentType === 'BIOMETRIC_CENTRAL_TEMPLATE') &&
          input.decision === 'GRANTED' &&
          doc.category !== 'SIGNED_CONSENT'
        ) {
          throw new BadRequestException({
            code: 'SIGNED_CONSENT_CATEGORY_REQUIRED',
            message:
              'La pièce rattachée à un consentement biométrique accordé (local ou central) doit appartenir à la catégorie SIGNED_CONSENT.',
          });
        }
      }

      // Clôture non destructive (historique conservé) de tout consentement GRANTED antérieur du même type
      await tx
        .update(employeeConsents)
        .set({
          decision: 'WITHDRAWN',
          withdrawnAt: new Date(),
          withdrawnBy: principal.userId,
          withdrawalReason: `Remplacé par une nouvelle décision (${input.decision}) — version ${input.policyVersion}.`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(employeeConsents.tenantId, tenantId),
            eq(employeeConsents.employeeId, employeeId),
            eq(employeeConsents.consentType, input.consentType),
            eq(employeeConsents.decision, 'GRANTED'),
          ),
        );

      const consentId = uuidv7();
      let inserted: typeof employeeConsents.$inferSelect | undefined;
      try {
        [inserted] = await tx
          .insert(employeeConsents)
          .values({
            id: consentId,
            tenantId,
            employeeId,
            consentType: input.consentType,
            decision: input.decision,
            policyVersion: input.policyVersion,
            collectionMethod: input.collectionMethod,
            noticeSummary: input.noticeSummary,
            alternativeQrPinOffered: true,
            signedDocumentId: input.signedDocumentId ?? null,
            recordedBy: principal.userId,
            ipAddress: meta.ipAddress,
          })
          .returning();
      } catch (err) {
        if (isPgUniqueViolation(err, 'uq_consents_one_granted_per_type')) {
          throw new ConflictException({
            code: 'CONCURRENT_CONSENT_CONFLICT',
            message:
              'Un consentement actif du même type a été enregistré simultanément pour cet agent. Veuillez réessayer.',
          });
        }
        throw err;
      }

      const updatedAttendanceMode = await this.syncEmployeeAttendanceMode(tx, tenantId, employeeId);

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_CONSENT_RECORDED',
        resourceType: 'employee_consent',
        resourceId: consentId,
        siteId: emp.primarySiteId,
        afterState: {
          employeeId,
          consentType: input.consentType,
          decision: input.decision,
          policyVersion: input.policyVersion,
          collectionMethod: input.collectionMethod,
          alternativeQrPinOffered: true,
          signedDocumentId: input.signedDocumentId ?? null,
          resultingAttendanceMode: updatedAttendanceMode,
        },
      });

      return { consent: inserted!, employeeAttendanceMode: updatedAttendanceMode };
    });
  }

  async withdrawConsent(
    principal: AuthenticatedPrincipal,
    employeeId: string,
    consentId: string,
    input: WithdrawEmployeeConsentInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    return this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const emp = await this.requireAccessibleEmployee(
        tx,
        principal,
        employeeId,
        'biometrics.consent.manage',
      );
      await tx.execute(
        sql`SELECT id FROM employees WHERE id = ${employeeId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`,
      );
      const [existing] = await tx
        .select()
        .from(employeeConsents)
        .where(
          and(
            eq(employeeConsents.id, consentId),
            eq(employeeConsents.employeeId, employeeId),
            eq(employeeConsents.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new NotFoundException({
          code: 'CONSENT_NOT_FOUND',
          message: 'Enregistrement de consentement introuvable sur ce dossier agent.',
        });
      }
      if (existing.decision !== 'GRANTED') {
        throw new ConflictException({
          code: 'CONSENT_NOT_ACTIVE',
          message: `Ce consentement est déjà au statut ${existing.decision}.`,
        });
      }

      const [updated] = await tx
        .update(employeeConsents)
        .set({
          decision: 'WITHDRAWN',
          withdrawnAt: new Date(),
          withdrawnBy: principal.userId,
          withdrawalReason: input.reason,
          updatedAt: new Date(),
        })
        .where(eq(employeeConsents.id, consentId))
        .returning();

      // Bascule automatique et sans pénalité vers l'alternative QR+PIN si plus aucun consentement biométrique actif
      const updatedAttendanceMode = await this.syncEmployeeAttendanceMode(tx, tenantId, employeeId);

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: this.actorType(principal),
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'EMPLOYEE_CONSENT_WITHDRAWN',
        resourceType: 'employee_consent',
        resourceId: consentId,
        siteId: emp.primarySiteId,
        reason: input.reason,
        beforeState: { decision: 'GRANTED', consentType: existing.consentType },
        afterState: {
          decision: 'WITHDRAWN',
          consentType: existing.consentType,
          resultingAttendanceMode: updatedAttendanceMode,
        },
      });

      return { consent: updated!, employeeAttendanceMode: updatedAttendanceMode };
    });
  }

  // ==========================================================================
  // Helpers internes de sécurité, anti-IDOR, chiffrement et conformité RDC
  // ==========================================================================

  private actorType(principal: AuthenticatedPrincipal): 'SUPERADMIN' | 'USER' {
    return principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER';
  }

  private assertSiteScope(
    principal: AuthenticatedPrincipal,
    permission: PermissionCode,
    siteId: string,
  ): void {
    if (canAccessSiteForPermission(principal, permission, siteId)) return;
    throw new ForbiddenException({
      code: 'SITE_SCOPE_DENIED',
      message: `Accès refusé : cet établissement est en dehors de votre périmètre autorisé pour ${permission}.`,
    });
  }

  /**
   * C-05 : Détermine la permission sensible additionnelle requise pour lire/télécharger
   * une pièce justificative selon sa catégorie (empêche le contournement de la protection
   * des salaires, des PII/aptitudes médicales et des consentements via le coffre S3).
   */
  private getDocumentCategoryReadPermission(category: string): PermissionCode | null {
    switch (category) {
      case 'EMPLOYMENT_CONTRACT':
      case 'CONTRACT_AMENDMENT':
        return 'employees.salary.read';
      case 'IDENTITY_DOC':
      case 'CNSS_CARD':
      case 'ONEM_VISA':
      case 'MEDICAL_FITNESS':
        return 'employees.pii.read';
      case 'SIGNED_CONSENT':
        return 'employees.consents.read';
      default:
        return null;
    }
  }

  private canReadDocumentCategory(
    principal: AuthenticatedPrincipal,
    employee: { id: string; primarySiteId: string; departmentId: string | null },
    category: string,
  ): boolean {
    const required = this.getDocumentCategoryReadPermission(category);
    if (!required) return true;
    return canAccessEmployeeForPermission(principal, required, employee);
  }

  private assertDocumentCategoryReadAccess(
    principal: AuthenticatedPrincipal,
    employee: { id: string; primarySiteId: string; departmentId: string | null },
    category: string,
  ): void {
    const required = this.getDocumentCategoryReadPermission(category);
    if (!required) return;
    if (!canAccessEmployeeForPermission(principal, required, employee)) {
      throw new ForbiddenException({
        code: 'DOCUMENT_CATEGORY_PERMISSION_DENIED',
        message: `La catégorie documentaire "${category}" exige la permission "${required}" sur le périmètre de cet agent.`,
      });
    }
  }

  private assertDocumentCategoryWriteAccess(
    principal: AuthenticatedPrincipal,
    employee: { id: string; primarySiteId: string; departmentId: string | null },
    category: string,
  ): void {
    let allowedAny: readonly PermissionCode[] | null = null;
    switch (category) {
      case 'EMPLOYMENT_CONTRACT':
      case 'CONTRACT_AMENDMENT':
        allowedAny = ['contracts.manage', 'employees.salary.manage'];
        break;
      case 'IDENTITY_DOC':
      case 'CNSS_CARD':
      case 'ONEM_VISA':
      case 'MEDICAL_FITNESS':
        allowedAny = ['employees.pii.read', 'employees.manage'];
        break;
      case 'SIGNED_CONSENT':
        allowedAny = ['biometrics.consent.manage', 'employees.consents.read'];
        break;
      default:
        allowedAny = null;
    }
    if (!allowedAny) return;
    const satisfied = allowedAny.some((perm) =>
      canAccessEmployeeForPermission(principal, perm, employee),
    );
    if (!satisfied) {
      throw new ForbiddenException({
        code: 'DOCUMENT_CATEGORY_PERMISSION_DENIED',
        message: `L’écriture ou la suppression dans la catégorie "${category}" exige l’une des permissions suivantes sur cet agent : ${allowedAny.join(', ')}.`,
      });
    }
  }

  /**
   * Point de contrôle unique anti-IDOR (C-02 / C-06) :
   * 1. PostgreSQL FORCE RLS filtre tout employé d'une autre entreprise -> 404 NOT_FOUND (zéro fuite d'existence).
   * 2. Vérifie le périmètre effectif PROPRE à `requiredPermission` (ALL_SITES, SELECTED_SITES,
   *    OWN_DEPARTMENT, SELF_ONLY — fail-closed) -> 403 SITE_SCOPE_DENIED.
   */
  private async requireAccessibleEmployee(
    tx: DrizzleTx,
    principal: AuthenticatedPrincipal,
    employeeId: string,
    requiredPermission: PermissionCode,
  ) {
    const [emp] = await tx
      .select()
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!emp) {
      throw new NotFoundException({
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Dossier employé introuvable.',
      });
    }

    if (!canAccessEmployeeForPermission(principal, requiredPermission, emp)) {
      throw new ForbiddenException({
        code: 'SITE_SCOPE_DENIED',
        message: `Accès refusé : ce dossier agent est en dehors de votre périmètre autorisé pour ${requiredPermission}.`,
      });
    }
    return emp;
  }

  private async loadTenantContext(tenantId: string): Promise<TenantHrContext> {
    return this.db.withPlatformTransaction(async (tx) => {
      const [t] = await tx
        .select({
          id: tenants.id,
          slug: tenants.slug,
          matriculePattern: tenants.matriculePattern,
          encryptionKeyRef: tenants.encryptionKeyRef,
          biometricStoragePolicy: tenants.biometricStoragePolicy,
          centralTemplateStorageEnabled: tenants.centralTemplateStorageEnabled,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!t) {
        throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Entreprise introuvable.' });
      }
      return t;
    });
  }

  private async assertValidOrgRefs(
    tx: DrizzleTx,
    refs: {
      departmentId: string | null;
      jobPositionId: string | null;
      managerEmployeeId: string | null;
      siteId: string;
    },
  ): Promise<void> {
    if (refs.departmentId) {
      const [dept] = await tx
        .select()
        .from(departments)
        .where(eq(departments.id, refs.departmentId))
        .limit(1);
      if (!dept) {
        throw new NotFoundException({
          code: 'DEPARTMENT_NOT_FOUND',
          message: 'Département introuvable dans cette entreprise.',
        });
      }
      if (dept.siteId && dept.siteId !== refs.siteId) {
        throw new BadRequestException({
          code: 'DEPARTMENT_SITE_MISMATCH',
          message: 'Ce département est rattaché à un autre établissement que le site de l’agent.',
        });
      }
    }

    if (refs.jobPositionId) {
      const [pos] = await tx
        .select()
        .from(jobPositions)
        .where(and(eq(jobPositions.id, refs.jobPositionId), eq(jobPositions.status, 'ACTIVE')))
        .limit(1);
      if (!pos) {
        throw new NotFoundException({
          code: 'JOB_POSITION_NOT_FOUND',
          message: 'Poste introuvable ou archivé dans cette entreprise.',
        });
      }
    }

    if (refs.managerEmployeeId) {
      const [mgr] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.id, refs.managerEmployeeId))
        .limit(1);
      if (!mgr) {
        throw new NotFoundException({
          code: 'MANAGER_NOT_FOUND',
          message: 'Supérieur hiérarchique introuvable dans cette entreprise.',
        });
      }
    }
  }

  private async assertEmployeeDocumentActive(
    tx: DrizzleTx,
    tenantId: string,
    employeeId: string,
    documentId: string,
  ) {
    const [doc] = await tx
      .select()
      .from(employeeDocuments)
      .where(
        and(
          eq(employeeDocuments.id, documentId),
          eq(employeeDocuments.employeeId, employeeId),
          eq(employeeDocuments.tenantId, tenantId),
          eq(employeeDocuments.status, 'ACTIVE'),
        ),
      )
      .limit(1);

    if (!doc) {
      throw new NotFoundException({
        code: 'SIGNED_DOCUMENT_NOT_FOUND',
        message: 'Pièce justificative introuvable dans le coffre documentaire de cet agent.',
      });
    }
    return doc;
  }

  private async recomputeTaxDependents(
    tx: DrizzleTx,
    tenantId: string,
    employeeId: string,
  ): Promise<number> {
    const rows = await tx
      .select({ id: employeeDependents.id })
      .from(employeeDependents)
      .where(
        and(
          eq(employeeDependents.tenantId, tenantId),
          eq(employeeDependents.employeeId, employeeId),
          eq(employeeDependents.status, 'ACTIVE'),
          eq(employeeDependents.isTaxDependent, true),
        ),
      );
    const count = Math.min(30, rows.length);
    await tx
      .update(employees)
      .set({ taxDependentsCount: count, updatedAt: new Date() })
      .where(and(eq(employees.id, employeeId), eq(employees.tenantId, tenantId)));
    return count;
  }

  private async syncEmployeeAttendanceMode(
    tx: DrizzleTx,
    tenantId: string,
    employeeId: string,
  ): Promise<'QR_PIN_ONLY' | 'BIOMETRIC_OR_QR_PIN'> {
    const activeBio = await tx
      .select({ id: employeeConsents.id })
      .from(employeeConsents)
      .where(
        and(
          eq(employeeConsents.tenantId, tenantId),
          eq(employeeConsents.employeeId, employeeId),
          eq(employeeConsents.decision, 'GRANTED'),
          inArray(employeeConsents.consentType, [
            'BIOMETRIC_DEVICE_ONLY',
            'BIOMETRIC_CENTRAL_TEMPLATE',
          ]),
        ),
      )
      .limit(1);

    const nextMode: 'QR_PIN_ONLY' | 'BIOMETRIC_OR_QR_PIN' =
      activeBio.length > 0 ? 'BIOMETRIC_OR_QR_PIN' : 'QR_PIN_ONLY';

    await tx
      .update(employees)
      .set({ attendanceMode: nextMode, updatedAt: new Date() })
      .where(and(eq(employees.id, employeeId), eq(employees.tenantId, tenantId)));

    return nextMode;
  }

  private sanitizeEmployee(row: typeof employees.$inferSelect) {
    const {
      encryptedPii: _pii,
      encryptedPayment: _pay,
      cnssBlindIndex: _cnssIdx,
      identityDocBlindIndex: _idIdx,
      ...safe
    } = row;
    return safe;
  }

  private sanitizeBadge(row: typeof employeeAttendanceBadges.$inferSelect) {
    const { qrTokenHash: _qr, pinArgon2Hash: _pin, ...safe } = row;
    return safe;
  }

  private formatContract(
    row: typeof employmentContracts.$inferSelect,
    tenantId: string,
    keyRef: string | null,
    canReadSalary: boolean,
  ) {
    const { encryptedBaseSalary, ...safe } = row;
    let baseSalary: string | null = null;

    if (canReadSalary && keyRef) {
      const plain = decryptEnvelope(
        this.config.security.masterKek,
        encryptedBaseSalary as EnvelopeCiphertext,
        {
          tenantScope: tenantId,
          keyRef,
          purpose: 'employee_salary',
          recordId: row.id,
        },
      ).toString('utf8');
      baseSalary = (JSON.parse(plain) as { baseSalary: string }).baseSalary;
    }

    return {
      ...safe,
      baseSalary,
      salaryRedacted: !canReadSalary,
    };
  }

  private decryptPiiOrEmpty(
    emp: typeof employees.$inferSelect,
    tenantId: string,
    keyRef: string,
  ): DecryptedPiiPayload {
    if (!emp.encryptedPii) {
      return { identityDocNumber: null, cnssNumber: null, individualTaxId: null };
    }
    const raw = decryptEnvelope(
      this.config.security.masterKek,
      emp.encryptedPii as EnvelopeCiphertext,
      {
        tenantScope: tenantId,
        keyRef,
        purpose: 'employee_pii',
        recordId: emp.id,
      },
    ).toString('utf8');
    return JSON.parse(raw) as DecryptedPiiPayload;
  }

  private decryptPaymentOrEmpty(
    emp: typeof employees.$inferSelect,
    tenantId: string,
    keyRef: string,
  ): DecryptedPaymentPayload {
    if (!emp.encryptedPayment) {
      return { bankAccountNumber: null, mobileMoneyNumber: null };
    }
    const raw = decryptEnvelope(
      this.config.security.masterKek,
      emp.encryptedPayment as EnvelopeCiphertext,
      {
        tenantScope: tenantId,
        keyRef,
        purpose: 'employee_payment',
        recordId: emp.id,
      },
    ).toString('utf8');
    return JSON.parse(raw) as DecryptedPaymentPayload;
  }

  private computeDrcContractAdvisories(input: CreateContractInput): string[] {
    // Avertissements consultatifs non bloquants : ne substituent jamais une validation
    // juridique locale en RDC et n'imposent pas de blocage rigide sur les cas dérogatoires.
    const advisories: string[] = [];
    if (input.contractType === 'CDD') {
      if (input.cddRenewalCount > 1) {
        advisories.push(
          'Alerte Code du Travail RDC (art. 41) : un CDD ne peut en principe être renouvelé qu’une seule fois entre les mêmes parties (sauf dérogation légale/sectorielle). À vérifier par le responsable RH.',
        );
      }
      if (input.endDate) {
        const maxStandardCddEnd = addCalendarMonthsIso(input.startDate, 24);
        if (input.endDate > maxStandardCddEnd) {
          advisories.push(
            'Alerte Code du Travail RDC (art. 41) : la durée calendaire du CDD dépasse 24 mois. Vérifiez l’éligibilité légale/sectorielle ou le risque de requalification en CDI avec votre conseil.',
          );
        }
      }
    }
    if (input.contractType === 'JOURNALIER') {
      advisories.push(
        'Rappel suivi contrat journalier (RF-M02-07) : la durée cumulée d’occupation journalière est encadrée en droit du travail RDC (risque de requalification au-delà du plafond légal). Assurez le suivi des jours prestés et validez le seuil applicable avec le service RH/juridique.',
      );
    }
    if (input.probationEndDate) {
      const sixMonthsFromStart = addCalendarMonthsIso(input.startDate, 6);
      if (input.probationEndDate > sixMonthsFromStart) {
        advisories.push(
          'Alerte période d’essai : la durée d’essai renseignée dépasse 6 mois calendaires. Vérifiez le plafond légal et conventionnel applicable à la catégorie professionnelle du poste en RDC.',
        );
      }
    }
    if (
      (input.contractType === 'CDI' || input.contractType === 'CDD') &&
      !input.onemVisaRef
    ) {
      advisories.push(
        'Rappel conformité RDC : pensez à soumettre le contrat écrit au visa de l’ONEM et à renseigner la référence de visa.',
      );
    }
    return advisories;
  }

  private decodeStrictBase64(input: string): Buffer {
    const clean = input.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) {
      throw new BadRequestException({
        code: 'DOCUMENT_BASE64_INVALID',
        message: 'Encodage Base64 du document invalide.',
      });
    }
    return Buffer.from(clean, 'base64');
  }

  /**
   * Vérifie la signature binaire réelle (magic bytes) du fichier pour empêcher tout
   * téléversement de contenu exécutable ou HTML déguisé sous une extension autorisée.
   */
  private assertDocumentMagicBytes(buf: Buffer, mime: AllowedDocumentMimeType): void {
    const ok =
      (mime === 'application/pdf' &&
        buf.length >= 5 &&
        buf.subarray(0, 5).toString('ascii') === '%PDF-') ||
      (mime === 'image/png' &&
        buf.length >= 8 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a) ||
      (mime === 'image/jpeg' &&
        buf.length >= 3 &&
        buf[0] === 0xff &&
        buf[1] === 0xd8 &&
        buf[2] === 0xff) ||
      (mime === 'image/webp' &&
        buf.length >= 12 &&
        buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buf.subarray(8, 12).toString('ascii') === 'WEBP');

    if (!ok) {
      throw new BadRequestException({
        code: 'DOCUMENT_MAGIC_BYTES_MISMATCH',
        message: `Le contenu binaire du fichier ne correspond pas au type déclaré (${mime}).`,
      });
    }
  }

  private extensionForMime(mime: AllowedDocumentMimeType): string {
    switch (mime) {
      case 'application/pdf':
        return 'pdf';
      case 'image/png':
        return 'png';
      case 'image/jpeg':
        return 'jpg';
      case 'image/webp':
        return 'webp';
    }
  }

  private async relayOutboxBestEffort(
    tenantId: string,
    outboxId: string,
    exchange: string,
    routingKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.bus.publish({
        eventId: outboxId,
        tenantId,
        exchange,
        routingKey,
        occurredAt: new Date().toISOString(),
        payload,
      });
      await this.db.withTenantTransaction(tenantId, null, async (tx) => {
        await tx
          .update(outboxEvents)
          .set({
            status: 'PUBLISHED',
            publishedAt: new Date(),
            attemptCount: 1,
            lastError: null,
          })
          .where(eq(outboxEvents.id, outboxId));
      });
    } catch (err) {
      // Enregistre l'échec avec recul exponentiel pour reprise automatique par OutboxRelayService
      await this.db
        .recordOutboxPublishFailure({ tenantId, outboxId, error: err })
        .catch(() => undefined);
    }
  }
}
