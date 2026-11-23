import {
  CanActivate,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { verifyEdDsaJwt, type AccessTokenClaims } from '@nexus-rh/crypto-audit';
import {
  NexusDatabase,
  and,
  employees,
  eq,
  gt,
  inArray,
  isNull,
  membershipSiteScopes,
  ne,
  or,
  permissions,
  rolePermissions,
  roles,
  tenantMemberships,
  tenants,
  userSessions,
  users,
} from '@nexus-rh/database';
import {
  MANDATORY_MFA_TENANT_ROLE_CODES,
  NON_SELF_OR_DEPARTMENT_PERMISSION_CODES,
} from '@nexus-rh/shared-types';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG, CACHE_LOCK_PORT, NEXUS_DB, type CacheLockPort } from '../infra/ports';
import {
  ALLOW_PENDING_MFA_SETUP_KEY,
  IS_PUBLIC_KEY,
  REQUIRED_PERMISSIONS_KEY,
  REQUIRE_MFA_VERIFIED_KEY,
  REQUIRE_SUPERADMIN_KEY,
  type AuthenticatedPrincipal,
  type NexusRequest,
  type PermissionScopeGrant,
} from './security';

const MANDATORY_MFA_ROLES = new Set<string>(MANDATORY_MFA_TENANT_ROLE_CODES);
const NON_DEPT_SELF_PERMS = new Set<string>(NON_SELF_OR_DEPARTMENT_PERMISSION_CODES);

interface MutablePermissionScope {
  allSites: boolean;
  siteIds: Set<string>;
  departmentIds: Set<string>;
  selfEmployeeId: string | null;
  contextSiteIds: Set<string>;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NEXUS_DB) private readonly db: NexusDatabase,
    @Inject(CACHE_LOCK_PORT) private readonly cache: CacheLockPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<NexusRequest>();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_MISSING',
        message: 'Authentification requise.',
      });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    let claims: AccessTokenClaims;
    try {
      claims = verifyEdDsaJwt<AccessTokenClaims>(
        token,
        this.config.security.jwtPublicKeyDerB64,
        {
          typ: 'access',
          iss: this.config.security.jwtIssuer,
          aud: this.config.security.jwtAudience,
        },
      );
    } catch {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_INVALID',
        message: 'Jeton d’accès invalide ou expiré.',
      });
    }

    // D-05 : Vérification fail-closed dans le magasin de révocation (503 contrôlé si Redis indisponible)
    let revoked: string | null;
    try {
      revoked = await this.cache.get(`jwt:revoked:${claims.jti}`);
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTH_REVOCATION_STORE_UNAVAILABLE',
        message:
          'Service de vérification de session momentanément indisponible. Veuillez réessayer.',
      });
    }
    if (revoked) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_REVOKED',
        message: 'Session révoquée. Veuillez vous reconnecter.',
      });
    }

    // Résolution sécurisée de l'utilisateur, de la session et du périmètre granulaire
    const principal = await this.resolvePrincipal(claims);
    req.principal = principal;

    // C-03 : Confinement strict tant qu'une obligation MFA active n'est pas satisfaite
    const allowPendingMfaSetup = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PENDING_MFA_SETUP_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (principal.mfaRequired && !principal.mfaVerified && !allowPendingMfaSetup) {
      if (!principal.mfaEnabled) {
        throw new ForbiddenException({
          code: 'MFA_SETUP_REQUIRED',
          message:
            'L’activation de l’authentification multi-facteurs (MFA TOTP) est obligatoire pour votre rôle avant d’accéder à cette ressource.',
        });
      }
      throw new ForbiddenException({
        code: 'MFA_STEP_UP_REQUIRED',
        message: 'Une vérification MFA active est requise pour accéder à cette ressource.',
      });
    }

    const requireSuperAdmin = this.reflector.getAllAndOverride<boolean>(REQUIRE_SUPERADMIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requireSuperAdmin && !principal.isPlatformSuperadmin) {
      throw new ForbiddenException({
        code: 'SUPERADMIN_REQUIRED',
        message: 'Accès réservé à la super-administration de la plateforme.',
      });
    }

    const requiredPermissions =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (requiredPermissions.length > 0) {
      if (!principal.activeTenantId) {
        throw new ForbiddenException({
          code: 'TENANT_CONTEXT_REQUIRED',
          message: 'Veuillez sélectionner une entreprise active avant d’effectuer cette action.',
        });
      }
      for (const perm of requiredPermissions) {
        if (!principal.permissions.has(perm)) {
          throw new ForbiddenException({
            code: 'PERMISSION_DENIED',
            message: `Permission insuffisante (${perm}).`,
          });
        }
      }
    }

    // C-03 : Vérification MFA explicite (Step-up) sur les opérations sensibles, même pour un rôle personnalisé
    const requireMfaVerified = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_MFA_VERIFIED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requireMfaVerified && !principal.mfaVerified) {
      throw new ForbiddenException({
        code: 'MFA_STEP_UP_REQUIRED',
        message:
          'Une session authentifiée par MFA (TOTP) est obligatoire pour exécuter cette opération sensible.',
      });
    }

    return true;
  }

  private async resolvePrincipal(claims: AccessTokenClaims): Promise<AuthenticatedPrincipal> {
    const now = new Date();
    const userAndSession = await this.db.withPlatformTransaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, claims.sub)).limit(1);
      if (!user || user.status !== 'ACTIVE') {
        return null;
      }

      const [session] = await tx
        .select()
        .from(userSessions)
        .where(
          and(
            eq(userSessions.id, claims.sid),
            eq(userSessions.userId, user.id),
            isNull(userSessions.revokedAt),
          ),
        )
        .limit(1);

      if (!session || session.expiresAt.getTime() <= now.getTime()) {
        return null;
      }

      // Cohérence stricte entre le claim `mfa` du jeton et l'état serveur de la session
      const effectiveMfaVerified = Boolean(claims.mfa && session.mfaVerified && user.mfaEnabled);

      let activeTenantId: string | null = claims.tid;
      if (activeTenantId) {
        if (session.activeTenantId !== activeTenantId) {
          return null;
        }
        const [tenant] = await tx
          .select()
          .from(tenants)
          .where(eq(tenants.id, activeTenantId))
          .limit(1);
        if (!tenant || (tenant.status !== 'ACTIVE' && tenant.status !== 'TRIAL')) {
          throw new ForbiddenException({
            code: 'TENANT_SUSPENDED_OR_CLOSED',
            message: 'L’accès à cette entreprise est actuellement suspendu ou clôturé.',
          });
        }
      }

      return { user, session, activeTenantId, effectiveMfaVerified };
    });

    if (!userAndSession) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        message: 'Session inactive ou expirée.',
      });
    }

    const { user, session, activeTenantId, effectiveMfaVerified } = userAndSession;
    const platformMfaRequired = Boolean(user.isPlatformSuperadmin || user.mfaRequired);

    if (!activeTenantId) {
      return {
        userId: user.id,
        email: user.email,
        fullName: user.fullName,
        sessionId: session.id,
        accessTokenJti: claims.jti,
        accessTokenExp: claims.exp,
        isPlatformSuperadmin: user.isPlatformSuperadmin,
        mfaEnabled: user.mfaEnabled,
        mfaRequired: platformMfaRequired,
        mfaVerified: effectiveMfaVerified,
        activeTenantId: null,
        roleCodes: user.isPlatformSuperadmin ? ['SUPER_ADMIN'] : [],
        permissions: new Set<string>(),
        permissionScopes: new Map<string, PermissionScopeGrant>(),
        hasGlobalTenantAdminRole: false,
        hasAllSitesAccess: false,
        allowedSiteIds: new Set<string>(),
      };
    }

    // Résolution granulaire des rôles, permissions et périmètres DANS le contexte RLS du tenant
    const resolved = await this.db.withTenantTransaction(activeTenantId, user.id, async (tx) => {
      const memberships = await tx
        .select({
          membershipId: tenantMemberships.id,
          roleId: roles.id,
          roleCode: roles.code,
          scopeType: tenantMemberships.scopeType,
          mfaRequired: tenantMemberships.mfaRequired,
          expiresAt: tenantMemberships.expiresAt,
        })
        .from(tenantMemberships)
        .innerJoin(roles, eq(tenantMemberships.roleId, roles.id))
        .where(
          and(
            eq(tenantMemberships.tenantId, activeTenantId),
            eq(tenantMemberships.userId, user.id),
            eq(tenantMemberships.status, 'ACTIVE'),
            or(isNull(tenantMemberships.expiresAt), gt(tenantMemberships.expiresAt, now)),
          ),
        );

      // C-04 : Aucune omnipotence silencieuse pour SUPER_ADMIN sans délégation active et non expirée
      if (memberships.length === 0) {
        throw new ForbiddenException({
          code: 'TENANT_MEMBERSHIP_REVOKED',
          message:
            'Vous ne disposez d’aucune appartenance ou délégation active (non expirée) sur cette entreprise.',
        });
      }

      const roleIds = Array.from(new Set(memberships.map((m) => m.roleId)));
      const permRows = await tx
        .select({
          roleId: rolePermissions.roleId,
          code: permissions.code,
        })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(inArray(rolePermissions.roleId, roleIds));

      const permsByRoleId = new Map<string, string[]>();
      for (const row of permRows) {
        const list = permsByRoleId.get(row.roleId) ?? [];
        list.push(row.code);
        permsByRoleId.set(row.roleId, list);
      }

      // Sites explicites par membership SELECTED_SITES
      const siteIdsByMembership = new Map<string, string[]>();
      const scopedMembershipIds = memberships
        .filter((m) => m.scopeType === 'SELECTED_SITES')
        .map((m) => m.membershipId);
      if (scopedMembershipIds.length > 0) {
        const siteRows = await tx
          .select({
            membershipId: membershipSiteScopes.membershipId,
            siteId: membershipSiteScopes.siteId,
          })
          .from(membershipSiteScopes)
          .where(inArray(membershipSiteScopes.membershipId, scopedMembershipIds));
        for (const sr of siteRows) {
          const list = siteIdsByMembership.get(sr.membershipId) ?? [];
          list.push(sr.siteId);
          siteIdsByMembership.set(sr.membershipId, list);
        }
      }

      // C-06 : Résolution fail-closed du dossier employé lié pour OWN_DEPARTMENT / SELF_ONLY
      let linkedEmployee: {
        id: string;
        primarySiteId: string;
        departmentId: string | null;
      } | null = null;
      const needsEmployeeLink = memberships.some(
        (m) => m.scopeType === 'OWN_DEPARTMENT' || m.scopeType === 'SELF_ONLY',
      );
      if (needsEmployeeLink) {
        const [emp] = await tx
          .select({
            id: employees.id,
            primarySiteId: employees.primarySiteId,
            departmentId: employees.departmentId,
          })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, activeTenantId),
              eq(employees.userId, user.id),
              ne(employees.status, 'TERMINATED'),
            ),
          )
          .limit(1);
        linkedEmployee = emp ?? null;
      }

      // C-02 : Construction de la table `permissionCode -> PermissionScopeGrant` sans fusion inter-rôles
      const mutableScopes = new Map<string, MutablePermissionScope>();
      const unionAllowedSiteIds = new Set<string>();

      const getOrCreateScope = (permCode: string): MutablePermissionScope => {
        let entry = mutableScopes.get(permCode);
        if (!entry) {
          entry = {
            allSites: false,
            siteIds: new Set<string>(),
            departmentIds: new Set<string>(),
            selfEmployeeId: null,
            contextSiteIds: new Set<string>(),
          };
          mutableScopes.set(permCode, entry);
        }
        return entry;
      };

      for (const m of memberships) {
        const rolePerms = permsByRoleId.get(m.roleId) ?? [];
        if (m.scopeType === 'ALL_SITES') {
          for (const permCode of rolePerms) {
            getOrCreateScope(permCode).allSites = true;
          }
        } else if (m.scopeType === 'SELECTED_SITES') {
          const mSites = siteIdsByMembership.get(m.membershipId) ?? [];
          // Fail-closed : si aucun site n'est attaché, n'octroie aucun site
          for (const sid of mSites) {
            unionAllowedSiteIds.add(sid);
          }
          for (const permCode of rolePerms) {
            const target = getOrCreateScope(permCode);
            for (const sid of mSites) {
              target.siteIds.add(sid);
            }
          }
        } else if (m.scopeType === 'OWN_DEPARTMENT') {
          for (const permCode of rolePerms) {
            // Les permissions d'administration globale ne s'exercent jamais en OWN_DEPARTMENT
            if (NON_DEPT_SELF_PERMS.has(permCode)) {
              continue;
            }
            const target = getOrCreateScope(permCode);
            if (linkedEmployee?.departmentId) {
              target.departmentIds.add(linkedEmployee.departmentId);
              target.contextSiteIds.add(linkedEmployee.primarySiteId);
            }
          }
        } else if (m.scopeType === 'SELF_ONLY') {
          for (const permCode of rolePerms) {
            if (NON_DEPT_SELF_PERMS.has(permCode)) {
              continue;
            }
            const target = getOrCreateScope(permCode);
            if (linkedEmployee) {
              target.selfEmployeeId = linkedEmployee.id;
              target.contextSiteIds.add(linkedEmployee.primarySiteId);
            }
          }
        }
        // Tout scopeType inconnu est ignoré (fail-closed)
      }

      const permissionScopes = new Map<string, PermissionScopeGrant>();
      const permSet = new Set<string>();
      for (const [code, scope] of mutableScopes) {
        permSet.add(code);
        permissionScopes.set(code, scope);
      }

      const hasGlobalTenantAdminRole = memberships.some(
        (m) => m.roleCode === 'TENANT_ADMIN' && m.scopeType === 'ALL_SITES',
      );
      const tenantMfaRequired = memberships.some(
        (m) => m.mfaRequired || MANDATORY_MFA_ROLES.has(m.roleCode),
      );
      const hasAllSitesAccess =
        permissionScopes.size > 0 &&
        Array.from(permissionScopes.values()).every((s) => s.allSites);

      return {
        roleCodes: Array.from(new Set(memberships.map((m) => m.roleCode))),
        permSet,
        permissionScopes,
        hasGlobalTenantAdminRole,
        tenantMfaRequired,
        hasAllSitesAccess,
        allowedSiteIds: unionAllowedSiteIds,
      };
    });

    return {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      sessionId: session.id,
      accessTokenJti: claims.jti,
      accessTokenExp: claims.exp,
      isPlatformSuperadmin: user.isPlatformSuperadmin,
      mfaEnabled: user.mfaEnabled,
      mfaRequired: platformMfaRequired || resolved.tenantMfaRequired,
      mfaVerified: effectiveMfaVerified,
      activeTenantId,
      roleCodes: resolved.roleCodes,
      permissions: resolved.permSet,
      permissionScopes: resolved.permissionScopes,
      hasGlobalTenantAdminRole: resolved.hasGlobalTenantAdminRole,
      hasAllSitesAccess: resolved.hasAllSitesAccess,
      allowedSiteIds: resolved.allowedSiteIds,
    };
  }
}
