import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { hashPassword, uuidv7 } from '@nexus-rh/crypto-audit';
import {
  NexusDatabase,
  and,
  asc,
  eq,
  inArray,
  isNull,
  isPgUniqueViolation,
  membershipSiteScopes,
  permissions,
  rolePermissions,
  roles,
  sites,
  sql,
  tenantMemberships,
  userSessions,
  users,
} from '@nexus-rh/database';
import {
  MANDATORY_MFA_TENANT_ROLE_CODES,
  NON_SELF_OR_DEPARTMENT_PERMISSION_CODES,
  SOD_CONFLICT_RULES,
  SUPPORT_DELEGATION_MAX_HOURS,
  createCustomRoleSchema,
  createTenantMemberSchema,
  detectSodConflicts,
} from '@nexus-rh/shared-types';
import { z } from 'zod';
import { NEXUS_DB } from '../../infra/ports';
import {
  CurrentPrincipal,
  ReqMeta,
  RequirePermissions,
  canAccessSiteForPermission,
  getPermissionScope,
  hasAllSitesForPermission,
  validateWithZod,
  type AuthenticatedPrincipal,
  type RequestMeta,
} from '../../common/security';

const MANDATORY_MFA_ROLES = new Set<string>(MANDATORY_MFA_TENANT_ROLE_CODES);
const NON_DEPT_SELF_PERMS = new Set<string>(NON_SELF_OR_DEPARTMENT_PERMISSION_CODES);

@Controller('rbac')
export class RbacController {
  constructor(@Inject(NEXUS_DB) private readonly db: NexusDatabase) {}

  @RequirePermissions('rbac.roles.read')
  @Get('permissions')
  async listPermissions() {
    const list = await this.db.withPlatformTransaction((tx) =>
      tx.select().from(permissions).orderBy(asc(permissions.module), asc(permissions.code)),
    );
    return {
      permissions: list,
      sodRules: SOD_CONFLICT_RULES,
    };
  }

  @RequirePermissions('rbac.roles.read')
  @Get('roles')
  async listRoles(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    const tenantId = principal.activeTenantId!;

    const result = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      // RLS retourne uniquement les rôles système (tenant_id IS NULL) + rôles propres au tenant actif
      const visibleRoles = await tx.select().from(roles).orderBy(asc(roles.code));
      const roleIds = visibleRoles.map((r) => r.id);
      const mappings =
        roleIds.length > 0
          ? await tx
              .select({ roleId: rolePermissions.roleId, code: permissions.code })
              .from(rolePermissions)
              .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
              .where(inArray(rolePermissions.roleId, roleIds))
          : [];

      const permsByRole = new Map<string, string[]>();
      for (const m of mappings) {
        const arr = permsByRole.get(m.roleId) ?? [];
        arr.push(m.code);
        permsByRole.set(m.roleId, arr);
      }

      return visibleRoles.map((r) => ({
        ...r,
        permissions: (permsByRole.get(r.id) ?? []).sort(),
      }));
    });

    return { roles: result };
  }

  @RequirePermissions('rbac.roles.manage')
  @Post('roles')
  async createCustomRole(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(createCustomRoleSchema, body);
    const tenantId = principal.activeTenantId!;
    // C-02 / C-04 : Autorité IAM uniquement si une MÊME adhésion porte TENANT_ADMIN + ALL_SITES
    const isTenantIamAuthority = principal.hasGlobalTenantAdminRole;

    if (!hasAllSitesForPermission(principal, 'rbac.roles.manage')) {
      throw new ForbiddenException({
        code: 'ALL_SITES_SCOPE_REQUIRED',
        message:
          'La création de rôles d’entreprise exige la permission rbac.roles.manage sur ALL_SITES.',
      });
    }
    if (!isTenantIamAuthority) {
      const unowned = input.permissions.filter(
        (code) => !hasAllSitesForPermission(principal, code),
      );
      if (unowned.length > 0) {
        throw new ForbiddenException({
          code: 'ROLE_PERMISSION_ESCALATION_FORBIDDEN',
          message: `Escalade de privilèges refusée : vous ne détenez pas sur ALL_SITES les permissions suivantes : ${unowned.join(', ')}.`,
        });
      }
    }

    // Contrôle obligatoire de Séparation des Tâches (SoD) sur le rôle lui-même
    const sodConflicts = detectSodConflicts(input.permissions);
    if (sodConflicts.length > 0) {
      throw new ConflictException({
        code: 'SOD_CONFLICT',
        message: sodConflicts[0]!.reason,
        conflicts: sodConflicts,
      });
    }

    const created = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const existing = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.code, input.code))
        .limit(1);

      if (existing.length > 0) {
        throw new ConflictException({
          code: 'ROLE_CODE_EXISTS',
          message: `Le code rôle "${input.code}" existe déjà (système ou entreprise).`,
        });
      }

      const uniquePermCodes = Array.from(new Set(input.permissions));
      const permRows = await tx
        .select()
        .from(permissions)
        .where(inArray(permissions.code, uniquePermCodes));

      const roleId = uuidv7();
      const [insertedRole] = await tx
        .insert(roles)
        .values({
          id: roleId,
          tenantId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          isSystem: false,
        })
        .returning();

      for (const pr of permRows) {
        await tx.insert(rolePermissions).values({ roleId, permissionId: pr.id });
      }

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'RBAC_CUSTOM_ROLE_CREATED',
        resourceType: 'role',
        resourceId: roleId,
        afterState: {
          code: input.code,
          name: input.name,
          permissions: uniquePermCodes,
        },
      });

      return { ...insertedRole!, permissions: uniquePermCodes.sort() };
    });

    return { role: created };
  }

  @RequirePermissions('rbac.members.read')
  @Get('members')
  async listMembers(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    const tenantId = principal.activeTenantId!;

    const readScope = getPermissionScope(principal, 'rbac.members.read');
    const members = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      if (!readScope) return [];
      const rows = await tx
        .select({
          membershipId: tenantMemberships.id,
          userId: users.id,
          email: users.email,
          fullName: users.fullName,
          mfaEnabled: users.mfaEnabled,
          mfaRequired: tenantMemberships.mfaRequired,
          expiresAt: tenantMemberships.expiresAt,
          supportJustification: tenantMemberships.supportJustification,
          roleId: roles.id,
          roleCode: roles.code,
          roleName: roles.name,
          scopeType: tenantMemberships.scopeType,
          status: tenantMemberships.status,
          createdAt: tenantMemberships.createdAt,
          revokedAt: tenantMemberships.revokedAt,
          revokedBy: tenantMemberships.revokedBy,
          revokeReason: tenantMemberships.revokeReason,
        })
        .from(tenantMemberships)
        .innerJoin(users, eq(tenantMemberships.userId, users.id))
        .innerJoin(roles, eq(tenantMemberships.roleId, roles.id))
        .where(eq(tenantMemberships.tenantId, tenantId))
        .orderBy(asc(users.fullName));

      const memIds = rows.map((r) => r.membershipId);
      const scopes =
        memIds.length > 0
          ? await tx
              .select({
                membershipId: membershipSiteScopes.membershipId,
                siteId: sites.id,
                siteCode: sites.code,
                siteName: sites.name,
              })
              .from(membershipSiteScopes)
              .innerJoin(sites, eq(membershipSiteScopes.siteId, sites.id))
              .where(inArray(membershipSiteScopes.membershipId, memIds))
          : [];

      const sitesByMembership = new Map<
        string,
        Array<{ siteId: string; siteCode: string; siteName: string }>
      >();
      for (const sc of scopes) {
        const arr = sitesByMembership.get(sc.membershipId) ?? [];
        arr.push({ siteId: sc.siteId, siteCode: sc.siteCode, siteName: sc.siteName });
        sitesByMembership.set(sc.membershipId, arr);
      }

      const enriched = rows.map((r) => ({
        ...r,
        sites: sitesByMembership.get(r.membershipId) ?? [],
      }));

      // C-02 : Un lecteur restreint à certains sites ne voit que les affectations couvrant ses sites
      if (readScope.allSites) {
        return enriched;
      }
      if (readScope.siteIds.size === 0) {
        return [];
      }
      return enriched.filter(
        (m) =>
          m.scopeType === 'SELECTED_SITES' &&
          m.sites.length > 0 &&
          m.sites.some((s) => readScope.siteIds.has(s.siteId)),
      );
    });

    return { members };
  }

  @RequirePermissions('rbac.members.manage')
  @Post('members')
  async addMember(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(createTenantMemberSchema, body);
    const tenantId = principal.activeTenantId!;
    const normalizedEmail = input.email.toLowerCase();

    // Anti-auto-élévation de privilèges (aucune exception, y compris délégation support)
    if (normalizedEmail === principal.email.toLowerCase()) {
      throw new ForbiddenException({
        code: 'SELF_PRIVILEGE_MODIFICATION_FORBIDDEN',
        message: 'Séparation des tâches : vous ne pouvez pas modifier vos propres rôles.',
      });
    }

    // Validation chronologique de l'échéance optionnelle (`expiresAt`)
    const now = new Date();
    let parsedExpiresAt: Date | null = null;
    if (input.expiresAt) {
      parsedExpiresAt = new Date(input.expiresAt);
      if (Number.isNaN(parsedExpiresAt.getTime()) || parsedExpiresAt.getTime() <= now.getTime() + 30_000) {
        throw new BadRequestException({
          code: 'INVALID_MEMBERSHIP_EXPIRY',
          message: 'La date d’expiration de l’accès doit être située dans le futur.',
        });
      }
    }

    // Résolution ou création du compte utilisateur
    const existingUser = await this.db.withPlatformTransaction(async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
      return u ?? null;
    });

    // C-04 : Toute délégation support à un Super-Admin exige une autorité TENANT_ADMIN globale
    // du client, une durée bornée (<= 72 h) et une justification explicite journalisée.
    const isTargetSuperadmin = Boolean(existingUser?.isPlatformSuperadmin);
    if (isTargetSuperadmin) {
      if (!principal.hasGlobalTenantAdminRole || principal.isPlatformSuperadmin) {
        throw new ForbiddenException({
          code: 'SUPPORT_DELEGATION_FORBIDDEN',
          message:
            'Seul un Administrateur Entreprise (TENANT_ADMIN ALL_SITES) du client peut accorder une délégation support temporaire à un Super-Administrateur.',
        });
      }
      const maxExpiryMs = now.getTime() + SUPPORT_DELEGATION_MAX_HOURS * 3_600_000;
      if (!parsedExpiresAt || parsedExpiresAt.getTime() > maxExpiryMs) {
        throw new BadRequestException({
          code: 'SUPPORT_DELEGATION_EXPIRY_REQUIRED',
          message: `Toute délégation support à un Super-Administrateur doit comporter une échéance obligatoire n’excédant pas ${SUPPORT_DELEGATION_MAX_HOURS} heures.`,
        });
      }
      if (!input.supportJustification || input.supportJustification.trim().length < 10) {
        throw new BadRequestException({
          code: 'SUPPORT_DELEGATION_JUSTIFICATION_REQUIRED',
          message:
            'Une justification explicite du client (min. 10 caractères) est obligatoire pour autoriser une délégation support.',
        });
      }
    }

    let targetUserId: string;
    if (existingUser) {
      targetUserId = existingUser.id;
    } else {
      if (!input.password) {
        throw new BadRequestException({
          code: 'PASSWORD_REQUIRED_FOR_NEW_USER',
          message: 'Un mot de passe initial robuste est requis pour créer ce nouvel utilisateur.',
        });
      }
      const pwHash = await hashPassword(input.password);
      targetUserId = uuidv7();
      // N-04 : `users.mfaRequired` reste false pour les comptes locataires (isolé sur tenant_memberships)
      await this.db.withPlatformTransaction(async (tx) => {
        await tx.insert(users).values({
          id: targetUserId,
          email: normalizedEmail,
          passwordHash: pwHash,
          fullName: input.fullName,
          isPlatformSuperadmin: false,
          mfaRequired: false,
          status: 'ACTIVE',
        });
      });
    }

    // Affectation au sein du tenant + vérification stricte C-02/C-06 + conflits SoD + validation des sites via RLS
    const manageScope = getPermissionScope(principal, 'rbac.members.manage');
    const membership = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const [targetRole] = await tx
        .select()
        .from(roles)
        .where(eq(roles.id, input.roleId))
        .limit(1);

      if (!targetRole) {
        throw new NotFoundException({
          code: 'ROLE_NOT_FOUND',
          message: 'Rôle introuvable dans cette entreprise.',
        });
      }

      const targetRolePerms = await tx
        .select({ code: permissions.code })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(eq(rolePermissions.roleId, targetRole.id));
      const targetPermCodes = targetRolePerms.map((p) => p.code);

      // C-06 : Interdire l'attribution de permissions d'échelle entreprise sous OWN_DEPARTMENT / SELF_ONLY
      if (input.scopeType === 'OWN_DEPARTMENT' || input.scopeType === 'SELF_ONLY') {
        const incompatible = targetPermCodes.filter((code) => NON_DEPT_SELF_PERMS.has(code));
        if (incompatible.length > 0) {
          throw new BadRequestException({
            code: 'INVALID_ROLE_SCOPE_COMBINATION',
            message: `Le périmètre ${input.scopeType} est incompatible avec les permissions d’administration suivantes : ${incompatible.join(', ')}.`,
          });
        }
      }

      // C-02 : Anti-escalade de rôle ET de périmètre strictement liée à chaque permission
      const isTenantIamAuthority = principal.hasGlobalTenantAdminRole;

      if (!isTenantIamAuthority) {
        const missingGrantorPerms = targetPermCodes.filter(
          (code) => !principal.permissions.has(code),
        );
        if (targetRole.code === 'TENANT_ADMIN' || missingGrantorPerms.length > 0) {
          throw new ForbiddenException({
            code: 'ROLE_ASSIGNMENT_ESCALATION_FORBIDDEN',
            message:
              'Escalade de privilèges refusée : vous ne pouvez pas attribuer un rôle disposant de permissions supérieures aux vôtres.',
          });
        }
      }

      if (!manageScope || !manageScope.allSites) {
        if (input.scopeType !== 'SELECTED_SITES') {
          throw new ForbiddenException({
            code: 'SITE_SCOPE_ESCALATION_FORBIDDEN',
            message:
              'Escalade de périmètre refusée : votre permission rbac.members.manage restreinte par site ne peut accorder que SELECTED_SITES.',
          });
        }
        const outOfManageScope = input.siteIds.filter(
          (id) => !canAccessSiteForPermission(principal, 'rbac.members.manage', id),
        );
        if (outOfManageScope.length > 0) {
          throw new ForbiddenException({
            code: 'SITE_SCOPE_ESCALATION_FORBIDDEN',
            message:
              'Escalade de périmètre refusée : un ou plusieurs établissements demandés sont hors de votre périmètre rbac.members.manage.',
          });
        }
      }

      // C-02 : Pour un gestionnaire délégué, vérifier également que CHAQUE permission du rôle cible
      // couvre le périmètre demandé (empêche de blanchir une permission limitée au site A vers le site B).
      if (!isTenantIamAuthority) {
        if (input.scopeType === 'SELECTED_SITES') {
          for (const permCode of targetPermCodes) {
            const uncoveredSite = input.siteIds.find(
              (siteId) => !canAccessSiteForPermission(principal, permCode, siteId),
            );
            if (uncoveredSite) {
              throw new ForbiddenException({
                code: 'SITE_SCOPE_ESCALATION_FORBIDDEN',
                message: `Escalade de périmètre refusée : vous ne détenez pas la permission "${permCode}" sur l’ensemble des établissements sélectionnés.`,
              });
            }
          }
        } else {
          const nonGlobalPerm = targetPermCodes.find(
            (permCode) => !hasAllSitesForPermission(principal, permCode),
          );
          if (nonGlobalPerm) {
            throw new ForbiddenException({
              code: 'SITE_SCOPE_ESCALATION_FORBIDDEN',
              message: `Escalade de périmètre refusée : vous ne détenez pas la permission "${nonGlobalPerm}" sur ALL_SITES.`,
            });
          }
        }
      }

      // Sérialisation atomique par (tenant, utilisateur) contre les doublons actifs concurrents
      // et pour garantir l'évaluation cohérente des conflits de séparation des tâches (SoD).
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`membership:${tenantId}:${targetUserId}`}, 0))`,
      );

      // Lecture complète des adhésions (actives, suspendues et historiques révoquées)
      const userMemberships = await tx
        .select({
          id: tenantMemberships.id,
          roleId: tenantMemberships.roleId,
          status: tenantMemberships.status,
          expiresAt: tenantMemberships.expiresAt,
        })
        .from(tenantMemberships)
        .where(
          and(
            eq(tenantMemberships.tenantId, tenantId),
            eq(tenantMemberships.userId, targetUserId),
          ),
        );

      // Clôture non destructive (jamais de DELETE) des délégations actives déjà arrivées à échéance
      const expiredActiveIds = userMemberships
        .filter(
          (m) =>
            m.status === 'ACTIVE' &&
            m.expiresAt !== null &&
            m.expiresAt.getTime() <= now.getTime(),
        )
        .map((m) => m.id);
      if (expiredActiveIds.length > 0) {
        await tx
          .update(tenantMemberships)
          .set({
            status: 'REVOKED',
            revokedAt: now,
            revokeReason: 'Délégation temporaire arrivée à expiration',
            updatedAt: now,
          })
          .where(inArray(tenantMemberships.id, expiredActiveIds));
      }
      const expiredIdSet = new Set(expiredActiveIds);

      const nonRevokedMemberships = userMemberships.filter(
        (m) =>
          !expiredIdSet.has(m.id) && (m.status === 'ACTIVE' || m.status === 'SUSPENDED'),
      );

      if (nonRevokedMemberships.some((m) => m.roleId === targetRole.id && m.status === 'ACTIVE')) {
        throw new ConflictException({
          code: 'MEMBERSHIP_ALREADY_EXISTS',
          message: 'Cet utilisateur possède déjà ce rôle actif dans cette entreprise.',
        });
      }

      if (
        nonRevokedMemberships.some((m) => m.roleId === targetRole.id && m.status === 'SUSPENDED')
      ) {
        throw new ConflictException({
          code: 'MEMBERSHIP_SUSPENDED',
          message:
            'Cet utilisateur dispose déjà d’une adhésion suspendue pour ce rôle. Révoquez-la avant toute nouvelle attribution.',
        });
      }

      const previousRevokedCount = userMemberships.filter(
        (m) => m.roleId === targetRole.id && m.status === 'REVOKED',
      ).length;

      // Contrôle SoD (4 yeux) sur l'union des rôles non révoqués existants + le rôle (ré)attribué
      const combinedRoleIds = [...nonRevokedMemberships.map((m) => m.roleId), targetRole.id];
      const combinedPerms = await tx
        .select({ code: permissions.code })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(inArray(rolePermissions.roleId, combinedRoleIds));

      const sodConflicts = detectSodConflicts(combinedPerms.map((p) => p.code));
      if (sodConflicts.length > 0) {
        throw new ConflictException({
          code: 'SOD_CONFLICT',
          message: sodConflicts[0]!.reason,
          conflicts: sodConflicts,
        });
      }

      // Vérifier que les sites sélectionnés appartiennent réellement au tenant (RLS)
      const uniqueSiteIds = Array.from(new Set(input.siteIds));
      if (input.scopeType === 'SELECTED_SITES') {
        const validSites = await tx
          .select({ id: sites.id })
          .from(sites)
          .where(inArray(sites.id, uniqueSiteIds));
        if (validSites.length !== uniqueSiteIds.length) {
          throw new BadRequestException({
            code: 'INVALID_SITE_SCOPE',
            message: 'Un ou plusieurs établissements sélectionnés n’appartiennent pas à cette entreprise.',
          });
        }
      }

      // N-04 / C-03 : Obligation MFA strictement isolée sur `tenant_memberships.mfa_required`
      // (aucune mutation globale irréversible de `users.mfa_required` entre tenants).
      const membershipMfaRequired = Boolean(
        MANDATORY_MFA_ROLES.has(targetRole.code) || input.mfaRequired || isTargetSuperadmin,
      );
      const supportJustification = input.supportJustification?.trim() || null;

      const membershipId = uuidv7();
      let inserted: typeof tenantMemberships.$inferSelect | undefined;
      try {
        [inserted] = await tx
          .insert(tenantMemberships)
          .values({
            id: membershipId,
            tenantId,
            userId: targetUserId,
            roleId: targetRole.id,
            scopeType: input.scopeType,
            mfaRequired: membershipMfaRequired,
            expiresAt: parsedExpiresAt,
            supportJustification,
            status: 'ACTIVE',
            createdBy: principal.userId,
          })
          .returning();
      } catch (err) {
        if (isPgUniqueViolation(err, 'uq_membership_tenant_user_role_active')) {
          throw new ConflictException({
            code: 'MEMBERSHIP_ALREADY_EXISTS',
            message: 'Cet utilisateur possède déjà ce rôle actif dans cette entreprise.',
          });
        }
        throw err;
      }

      if (input.scopeType === 'SELECTED_SITES') {
        for (const siteId of uniqueSiteIds) {
          await tx.insert(membershipSiteScopes).values({
            membershipId,
            siteId,
            tenantId,
          });
        }
      }

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: isTargetSuperadmin ? 'RBAC_SUPPORT_DELEGATION_GRANTED' : 'RBAC_MEMBER_ASSIGNED',
        resourceType: 'tenant_membership',
        resourceId: membershipId,
        reason: supportJustification,
        afterState: {
          userId: targetUserId,
          email: normalizedEmail,
          roleCode: targetRole.code,
          scopeType: input.scopeType,
          mfaRequired: membershipMfaRequired,
          expiresAt: parsedExpiresAt ? parsedExpiresAt.toISOString() : null,
          isSupportDelegation: isTargetSuperadmin,
          siteIds: input.scopeType === 'SELECTED_SITES' ? uniqueSiteIds : [],
          reassignedAfterRevocation: previousRevokedCount > 0,
          previousRevokedCount,
        },
      });

      return {
        ...inserted!,
        email: normalizedEmail,
        fullName: existingUser?.fullName ?? input.fullName,
        roleCode: targetRole.code,
        roleName: targetRole.name,
      };
    });

    return { membership };
  }

  @RequirePermissions('rbac.members.manage')
  @Delete('members/:membershipId')
  async revokeMember(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('membershipId') membershipId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    const validId = validateWithZod(z.string().uuid('Identifiant invalide.'), membershipId);
    const tenantId = principal.activeTenantId!;

    const revokedUserId = await this.db.withTenantTransaction(
      tenantId,
      principal.userId,
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(tenantMemberships)
          .where(eq(tenantMemberships.id, validId))
          .limit(1);

        if (!existing) {
          throw new NotFoundException({
            code: 'MEMBERSHIP_NOT_FOUND',
            message: 'Affectation introuvable.',
          });
        }

        if (existing.userId === principal.userId) {
          throw new ForbiddenException({
            code: 'SELF_REVOKE_FORBIDDEN',
            message: 'Vous ne pouvez pas révoquer votre propre affectation de rôle.',
          });
        }

        // C-02 / C-04 : Vérification stricte liée à `rbac.members.manage` et à chaque permission cible
        const isTenantIamAuthority = principal.hasGlobalTenantAdminRole;
        const manageScope = getPermissionScope(principal, 'rbac.members.manage');

        const targetRolePerms = !isTenantIamAuthority
          ? await tx
              .select({ code: permissions.code })
              .from(rolePermissions)
              .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
              .where(eq(rolePermissions.roleId, existing.roleId))
          : [];

        if (!isTenantIamAuthority) {
          const [existingRole] = await tx
            .select({ code: roles.code })
            .from(roles)
            .where(eq(roles.id, existing.roleId))
            .limit(1);
          const higherPerms = targetRolePerms
            .map((p) => p.code)
            .filter((code) => !principal.permissions.has(code));
          if (existingRole?.code === 'TENANT_ADMIN' || higherPerms.length > 0) {
            throw new ForbiddenException({
              code: 'MEMBER_REVOKE_ESCALATION_FORBIDDEN',
              message:
                'Vous ne pouvez pas révoquer une affectation détenant des privilèges supérieurs aux vôtres.',
            });
          }
        }

        if (!manageScope || !manageScope.allSites) {
          if (existing.scopeType !== 'SELECTED_SITES') {
            throw new ForbiddenException({
              code: 'SITE_SCOPE_ESCALATION_FORBIDDEN',
              message: 'Vous ne pouvez pas révoquer une affectation de portée globale.',
            });
          }
          const targetScopes = await tx
            .select({ siteId: membershipSiteScopes.siteId })
            .from(membershipSiteScopes)
            .where(eq(membershipSiteScopes.membershipId, existing.id));
          if (
            targetScopes.length === 0 ||
            targetScopes.some(
              (s) => !canAccessSiteForPermission(principal, 'rbac.members.manage', s.siteId),
            )
          ) {
            throw new ForbiddenException({
              code: 'SITE_SCOPE_ESCALATION_FORBIDDEN',
              message: 'Cette affectation couvre un établissement hors de votre périmètre.',
            });
          }
          if (!isTenantIamAuthority) {
            for (const p of targetRolePerms) {
              if (
                targetScopes.some(
                  (s) => !canAccessSiteForPermission(principal, p.code, s.siteId),
                )
              ) {
                throw new ForbiddenException({
                  code: 'SITE_SCOPE_ESCALATION_FORBIDDEN',
                  message: `Vous ne détenez pas la permission "${p.code}" sur tous les établissements de cette affectation.`,
                });
              }
            }
          }
        } else if (!isTenantIamAuthority) {
          if (existing.scopeType === 'SELECTED_SITES') {
            const targetScopes = await tx
              .select({ siteId: membershipSiteScopes.siteId })
              .from(membershipSiteScopes)
              .where(eq(membershipSiteScopes.membershipId, existing.id));
            for (const p of targetRolePerms) {
              if (
                targetScopes.some(
                  (s) => !canAccessSiteForPermission(principal, p.code, s.siteId),
                )
              ) {
                throw new ForbiddenException({
                  code: 'SITE_SCOPE_ESCALATION_FORBIDDEN',
                  message: `Vous ne détenez pas la permission "${p.code}" sur tous les établissements de cette affectation.`,
                });
              }
            }
          } else if (
            targetRolePerms.some((p) => !hasAllSitesForPermission(principal, p.code))
          ) {
            throw new ForbiddenException({
              code: 'SITE_SCOPE_ESCALATION_FORBIDDEN',
              message: 'Vous ne pouvez pas révoquer une affectation dont le périmètre dépasse le vôtre.',
            });
          }
        }

        if (existing.status === 'REVOKED') {
          throw new ConflictException({
            code: 'MEMBERSHIP_ALREADY_REVOKED',
            message: 'Cette affectation de rôle est déjà révoquée.',
          });
        }

        const revokedAt = new Date();
        await tx
          .update(tenantMemberships)
          .set({
            status: 'REVOKED',
            revokedAt,
            revokedBy: principal.userId,
            revokeReason: 'Révocation administrative RBAC',
            updatedAt: revokedAt,
          })
          .where(eq(tenantMemberships.id, validId));

        await this.db.appendAuditLog(tx, {
          tenantId,
          actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
          actorId: principal.userId,
          actorEmail: principal.email,
          actorRole: principal.roleCodes.join(','),
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          action: 'RBAC_MEMBER_REVOKED',
          resourceType: 'tenant_membership',
          resourceId: validId,
          beforeState: { status: existing.status, roleId: existing.roleId },
          afterState: { status: 'REVOKED', revokedAt: revokedAt.toISOString() },
        });

        return existing.userId;
      },
    );

    // Révocation immédiate des sessions actives de cet utilisateur sur ce tenant
    await this.db.withPlatformTransaction(async (tx) => {
      await tx
        .update(userSessions)
        .set({ revokedAt: new Date(), revokeReason: 'MEMBERSHIP_REVOKED' })
        .where(
          and(
            eq(userSessions.userId, revokedUserId),
            eq(userSessions.activeTenantId, tenantId),
            isNull(userSessions.revokedAt),
          ),
        );
    });

    return { revoked: true };
  }
}
