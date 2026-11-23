import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hashPassword, uuidv7 } from '@nexus-rh/crypto-audit';
import {
  NexusDatabase,
  and,
  desc,
  eq,
  isNull,
  outboxEvents,
  roles,
  sites,
  tenantMemberships,
  tenants,
  userSessions,
  users,
} from '@nexus-rh/database';
import type {
  CreateTenantInput,
  UpdateBiometricPolicyInput,
  UpdateTenantProfileInput,
  UpdateTenantStatusInput,
} from '@nexus-rh/shared-types';
import {
  MESSAGE_BUS_PORT,
  NEXUS_DB,
  type MessageBusPort,
} from '../../infra/ports';
import {
  hasAllSitesForPermission,
  type AuthenticatedPrincipal,
  type RequestMeta,
} from '../../common/security';

@Injectable()
export class TenantsService {
  constructor(
    @Inject(NEXUS_DB) private readonly db: NexusDatabase,
    @Inject(MESSAGE_BUS_PORT) private readonly bus: MessageBusPort,
  ) {}

  async listPlatformTenants() {
    return this.db.withPlatformTransaction(async (tx) => {
      return tx.select().from(tenants).orderBy(desc(tenants.createdAt));
    });
  }

  /**
   * Provisionnement complet et audité d'une nouvelle entreprise cliente :
   * 1. Création du tenant avec politique biométrique DEVICE_ONLY obligatoire par défaut.
   * 2. Création de l'établissement siège (dans une transaction isolée RLS).
   * 3. Création optionnelle de l'administrateur entreprise initial (MFA requise).
   * 4. Publication via Transactional Outbox de l'événement `tenant.provisioned`.
   * 5. Double journalisation SHA-256 (chaîne PLATFORM + genèse de la chaîne du TENANT).
   */
  async createTenant(
    principal: AuthenticatedPrincipal,
    input: CreateTenantInput,
    meta: RequestMeta,
  ) {
    const tenantId = uuidv7();
    const hqSiteId = uuidv7();
    const outboxId = uuidv7();
    const encryptionKeyRef = `tenant-kek-v1:${uuidv7()}`;

    const initialAdminPwHash = input.initialAdmin
      ? await hashPassword(input.initialAdmin.password)
      : null;

    const createdTenant = await this.db.withPlatformTransaction(async (tx) => {
      const [existing] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, input.slug))
        .limit(1);

      if (existing) {
        throw new ConflictException({
          code: 'TENANT_SLUG_EXISTS',
          message: `Le code entreprise "${input.slug}" est déjà utilisé.`,
        });
      }

      const [inserted] = await tx
        .insert(tenants)
        .values({
          id: tenantId,
          slug: input.slug,
          legalName: input.legalName,
          tradeName: input.tradeName ?? null,
          legalForm: input.legalForm,
          countryCode: 'CD',
          sectorCode: input.sectorCode,
          rccm: input.rccm ?? null,
          idNat: input.idNat ?? null,
          taxIdDgi: input.taxIdDgi ?? null,
          cnssEmployerNumber: input.cnssEmployerNumber ?? null,
          inppEmployerNumber: input.inppEmployerNumber ?? null,
          onemEmployerNumber: input.onemEmployerNumber ?? null,
          defaultCurrency: input.defaultCurrency,
          matriculePattern: input.matriculePattern,
          encryptionKeyRef,
          biometricStoragePolicy: 'DEVICE_ONLY',
          centralTemplateStorageEnabled: false,
          status: 'ACTIVE',
          isDemoTenant: input.isDemoTenant,
        })
        .returning();

      if (input.initialAdmin && initialAdminPwHash) {
        const email = input.initialAdmin.email.toLowerCase();
        const [existingUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        const adminUserId = existingUser?.id ?? uuidv7();
        if (!existingUser) {
          // N-04 : `users.mfaRequired` est réservé au niveau plateforme ;
          // l'obligation MFA d'entreprise est isolée sur `tenant_memberships.mfa_required`.
          await tx.insert(users).values({
            id: adminUserId,
            email,
            passwordHash: initialAdminPwHash,
            fullName: input.initialAdmin.fullName,
            isPlatformSuperadmin: false,
            mfaRequired: false,
            status: 'ACTIVE',
          });
        }

        const [tenantAdminRole] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(and(isNull(roles.tenantId), eq(roles.code, 'TENANT_ADMIN')))
          .limit(1);

        if (tenantAdminRole) {
          await tx.insert(tenantMemberships).values({
            id: uuidv7(),
            tenantId,
            userId: adminUserId,
            roleId: tenantAdminRole.id,
            scopeType: 'ALL_SITES',
            mfaRequired: true,
            status: 'ACTIVE',
            createdBy: principal.userId,
          });
        }
      }

      await this.db.appendAuditLog(tx, {
        tenantId: null,
        actorType: 'SUPERADMIN',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: 'SUPER_ADMIN',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'TENANT_PROVISIONED',
        resourceType: 'tenant',
        resourceId: tenantId,
        afterState: {
          slug: input.slug,
          legalName: input.legalName,
          legalForm: input.legalForm,
          defaultCurrency: input.defaultCurrency,
          biometricStoragePolicy: 'DEVICE_ONLY',
          isDemoTenant: input.isDemoTenant,
          headquartersTimezone: input.headquartersSite.timezone,
        },
      });

      return inserted!;
    });

    // Création de l'établissement siège et de l'entrée genèse d'audit dans le contexte RLS du tenant
    const hqSite = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const [site] = await tx
        .insert(sites)
        .values({
          id: hqSiteId,
          tenantId,
          code: input.headquartersSite.code,
          name: input.headquartersSite.name,
          siteType: 'HEADQUARTERS',
          province: input.headquartersSite.province,
          city: input.headquartersSite.city,
          commune: input.headquartersSite.commune ?? null,
          addressLine: input.headquartersSite.addressLine ?? null,
          timezone: input.headquartersSite.timezone,
          isHeadquarters: true,
          status: 'ACTIVE',
        })
        .returning();

      await tx.insert(outboxEvents).values({
        id: outboxId,
        tenantId,
        exchange: 'nexus.tenants',
        routingKey: 'tenant.provisioned',
        payload: {
          tenantId,
          slug: createdTenant.slug,
          headquartersSiteId: hqSiteId,
          biometricStoragePolicy: 'DEVICE_ONLY',
        },
        status: 'PENDING',
      });

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: 'SUPERADMIN',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: 'SUPER_ADMIN',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'TENANT_CHAIN_INITIALIZED',
        resourceType: 'tenant',
        resourceId: tenantId,
        siteId: hqSiteId,
        afterState: {
          legalName: createdTenant.legalName,
          biometricStoragePolicy: 'DEVICE_ONLY',
          centralTemplateStorageEnabled: false,
          headquartersSite: {
            code: input.headquartersSite.code,
            city: input.headquartersSite.city,
            province: input.headquartersSite.province,
            timezone: input.headquartersSite.timezone,
          },
        },
      });

      return site!;
    });

    // Relais immédiat best-effort de l'Outbox vers le bus de messages (RabbitMQ / Sandbox)
    await this.relayOutboxEvent(tenantId, outboxId, {
      eventId: outboxId,
      tenantId,
      exchange: 'nexus.tenants',
      routingKey: 'tenant.provisioned',
      occurredAt: new Date().toISOString(),
      payload: { tenantId, slug: createdTenant.slug, hqSiteId },
    });

    return { tenant: createdTenant, headquartersSite: hqSite };
  }

  async updateTenantStatus(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    input: UpdateTenantStatusInput,
    meta: RequestMeta,
  ) {
    return this.db.withPlatformTransaction(async (tx) => {
      const [existing] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (!existing) {
        throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Entreprise introuvable.' });
      }

      const [updated] = await tx
        .update(tenants)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId))
        .returning();

      // Si suspension ou clôture, révoquer immédiatement toutes les sessions actives sur ce tenant
      if (input.status === 'SUSPENDED' || input.status === 'CLOSED') {
        await tx
          .update(userSessions)
          .set({ revokedAt: new Date(), revokeReason: `TENANT_${input.status}` })
          .where(
            and(eq(userSessions.activeTenantId, tenantId), isNull(userSessions.revokedAt)),
          );
      }

      await this.db.appendAuditLog(tx, {
        tenantId: null,
        actorType: 'SUPERADMIN',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: 'SUPER_ADMIN',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'TENANT_STATUS_UPDATED',
        resourceType: 'tenant',
        resourceId: tenantId,
        reason: input.reason,
        beforeState: { status: existing.status },
        afterState: { status: input.status },
      });

      return updated!;
    });
  }

  async getActiveTenantProfile(principal: AuthenticatedPrincipal) {
    const tenantId = principal.activeTenantId!;
    return this.db.withPlatformTransaction(async (tx) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (!tenant) {
        throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Entreprise introuvable.' });
      }
      return this.sanitizeTenant(tenant);
    });
  }

  async updateActiveTenantProfile(
    principal: AuthenticatedPrincipal,
    input: UpdateTenantProfileInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;
    if (!hasAllSitesForPermission(principal, 'tenant.update')) {
      throw new ForbiddenException({
        code: 'ALL_SITES_SCOPE_REQUIRED',
        message:
          'La modification du profil juridique de l’entreprise exige la permission tenant.update sur ALL_SITES.',
      });
    }

    const { before, after } = await this.db.withPlatformTransaction(async (tx) => {
      const [existing] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (!existing) {
        throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Entreprise introuvable.' });
      }

      const [updated] = await tx
        .update(tenants)
        .set({
          ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
          ...(input.tradeName !== undefined ? { tradeName: input.tradeName } : {}),
          ...(input.legalForm !== undefined ? { legalForm: input.legalForm } : {}),
          ...(input.sectorCode !== undefined ? { sectorCode: input.sectorCode } : {}),
          ...(input.rccm !== undefined ? { rccm: input.rccm } : {}),
          ...(input.idNat !== undefined ? { idNat: input.idNat } : {}),
          ...(input.taxIdDgi !== undefined ? { taxIdDgi: input.taxIdDgi } : {}),
          ...(input.cnssEmployerNumber !== undefined
            ? { cnssEmployerNumber: input.cnssEmployerNumber }
            : {}),
          ...(input.inppEmployerNumber !== undefined
            ? { inppEmployerNumber: input.inppEmployerNumber }
            : {}),
          ...(input.onemEmployerNumber !== undefined
            ? { onemEmployerNumber: input.onemEmployerNumber }
            : {}),
          ...(input.defaultCurrency !== undefined
            ? { defaultCurrency: input.defaultCurrency }
            : {}),
          ...(input.matriculePattern !== undefined
            ? { matriculePattern: input.matriculePattern }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId))
        .returning();

      return { before: existing, after: updated! };
    });

    await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'TENANT_PROFILE_UPDATED',
        resourceType: 'tenant',
        resourceId: tenantId,
        beforeState: this.sanitizeTenant(before),
        afterState: this.sanitizeTenant(after),
      });
    });

    return this.sanitizeTenant(after);
  }

  /**
   * Gouvernance de la politique biométrique (Décision propriétaire n° 6) :
   * - Par défaut : DEVICE_ONLY (aucun gabarit stocké au centre).
   * - Toute activation de ENCRYPTED_CENTRAL_SYNC exige une session vérifiée par MFA (step-up),
   *   une référence d'autorisation juridique valide et un motif journalisé de manière immuable.
   */
  async updateBiometricPolicy(
    principal: AuthenticatedPrincipal,
    input: UpdateBiometricPolicyInput,
    meta: RequestMeta,
  ) {
    const tenantId = principal.activeTenantId!;

    if (!hasAllSitesForPermission(principal, 'tenant.biometric_policy.manage')) {
      throw new ForbiddenException({
        code: 'ALL_SITES_SCOPE_REQUIRED',
        message:
          'La modification de la politique biométrique d’entreprise exige la permission tenant.biometric_policy.manage sur ALL_SITES.',
      });
    }

    if (!principal.mfaVerified) {
      throw new ForbiddenException({
        code: 'MFA_STEP_UP_REQUIRED',
        message:
          'L’authentification multi-facteurs (MFA) active et vérifiée est obligatoire pour modifier la politique de stockage biométrique.',
      });
    }

    const { before, after } = await this.db.withPlatformTransaction(async (tx) => {
      const [existing] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (!existing) {
        throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Entreprise introuvable.' });
      }

      const isDeviceOnly = input.policy === 'DEVICE_ONLY';
      const [updated] = await tx
        .update(tenants)
        .set({
          biometricStoragePolicy: input.policy,
          centralTemplateStorageEnabled: isDeviceOnly ? false : input.centralTemplateStorageEnabled,
          biometricLegalAuthorizationRef: isDeviceOnly
            ? null
            : (input.legalAuthorizationRef ?? null),
          biometricPolicyApprovedBy: isDeviceOnly ? null : principal.userId,
          biometricPolicyApprovedAt: isDeviceOnly ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId))
        .returning();

      return { before: existing, after: updated! };
    });

    await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'TENANT_BIOMETRIC_POLICY_CHANGED',
        resourceType: 'tenant',
        resourceId: tenantId,
        reason: input.reason,
        beforeState: {
          biometricStoragePolicy: before.biometricStoragePolicy,
          centralTemplateStorageEnabled: before.centralTemplateStorageEnabled,
          biometricLegalAuthorizationRef: before.biometricLegalAuthorizationRef,
        },
        afterState: {
          biometricStoragePolicy: after.biometricStoragePolicy,
          centralTemplateStorageEnabled: after.centralTemplateStorageEnabled,
          biometricLegalAuthorizationRef: after.biometricLegalAuthorizationRef,
          biometricPolicyApprovedBy: after.biometricPolicyApprovedBy,
        },
      });
    });

    return this.sanitizeTenant(after);
  }

  private sanitizeTenant(t: typeof tenants.$inferSelect) {
    const { encryptionKeyRef: _hidden, ...safe } = t;
    return safe;
  }

  private async relayOutboxEvent(
    tenantId: string,
    outboxId: string,
    event: {
      eventId: string;
      tenantId: string;
      exchange: string;
      routingKey: string;
      occurredAt: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.bus.publish(event);
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
