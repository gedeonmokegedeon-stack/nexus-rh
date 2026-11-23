import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { uuidv7 } from '@nexus-rh/crypto-audit';
import {
  NexusDatabase,
  and,
  asc,
  departments,
  eq,
  inArray,
  isNull,
  or,
  sites,
} from '@nexus-rh/database';
import {
  DRC_PROVINCES,
  createDepartmentSchema,
  createSiteSchema,
  updateSiteSchema,
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

@Controller()
export class OrganizationController {
  constructor(@Inject(NEXUS_DB) private readonly db: NexusDatabase) {}

  @RequirePermissions('organization.sites.read')
  @Get('reference/drc-provinces')
  getDrcProvinces() {
    return { provinces: DRC_PROVINCES };
  }

  @RequirePermissions('organization.sites.read')
  @Get('sites')
  async listSites(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    const tenantId = principal.activeTenantId!;
    const scope = getPermissionScope(principal, 'organization.sites.read');
    const rows = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      // C-02 : Filtrage strictement sur le périmètre de `organization.sites.read`
      if (!scope) return [];
      if (scope.allSites) {
        return tx.select().from(sites).orderBy(asc(sites.code));
      }
      const allowedSet = new Set<string>([...scope.siteIds, ...scope.contextSiteIds]);
      if (allowedSet.size === 0) return [];
      return tx
        .select()
        .from(sites)
        .where(inArray(sites.id, Array.from(allowedSet)))
        .orderBy(asc(sites.code));
    });

    return { sites: rows };
  }

  @RequirePermissions('organization.sites.manage')
  @Post('sites')
  async createSite(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(createSiteSchema, body);
    const tenantId = principal.activeTenantId!;

    if (!hasAllSitesForPermission(principal, 'organization.sites.manage')) {
      throw new ForbiddenException({
        code: 'ALL_SITES_SCOPE_REQUIRED',
        message:
          'La création d’un nouvel établissement exige la permission organization.sites.manage sur ALL_SITES.',
      });
    }

    const created = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      const [dup] = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.tenantId, tenantId), eq(sites.code, input.code)))
        .limit(1);

      if (dup) {
        throw new ConflictException({
          code: 'SITE_CODE_EXISTS',
          message: `Un établissement avec le code "${input.code}" existe déjà dans cette entreprise.`,
        });
      }

      if (input.isHeadquarters) {
        await tx
          .update(sites)
          .set({ isHeadquarters: false, updatedAt: new Date() })
          .where(eq(sites.tenantId, tenantId));
      }

      const siteId = uuidv7();
      const [inserted] = await tx
        .insert(sites)
        .values({
          id: siteId,
          tenantId,
          code: input.code,
          name: input.name,
          siteType: input.siteType,
          province: input.province,
          city: input.city,
          commune: input.commune ?? null,
          addressLine: input.addressLine ?? null,
          timezone: input.timezone,
          latitude: input.latitude !== undefined && input.latitude !== null ? String(input.latitude) : null,
          longitude: input.longitude !== undefined && input.longitude !== null ? String(input.longitude) : null,
          geofenceRadiusMeters: input.geofenceRadiusMeters ?? null,
          transportZoneCode: input.transportZoneCode ?? null,
          isHeadquarters: input.isHeadquarters,
          status: 'ACTIVE',
        })
        .returning();

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'SITE_CREATED',
        resourceType: 'site',
        resourceId: siteId,
        siteId,
        afterState: inserted,
      });

      return inserted!;
    });

    return { site: created };
  }

  @RequirePermissions('organization.sites.manage')
  @Patch('sites/:id')
  async updateSite(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const siteId = validateWithZod(z.string().uuid('Identifiant d’établissement invalide.'), id);
    const input = validateWithZod(updateSiteSchema, body);
    const tenantId = principal.activeTenantId!;

    // C-02 : Protection anti-IDOR horizontale liée à `organization.sites.manage`
    if (!canAccessSiteForPermission(principal, 'organization.sites.manage', siteId)) {
      throw new ForbiddenException({
        code: 'SITE_SCOPE_DENIED',
        message: 'Cet établissement est hors de votre périmètre autorisé pour organization.sites.manage.',
      });
    }

    const updated = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      // Si siteId appartient à un autre tenant, PostgreSQL RLS retourne 0 ligne -> 404 propre
      const [existing] = await tx.select().from(sites).where(eq(sites.id, siteId)).limit(1);
      if (!existing) {
        throw new NotFoundException({
          code: 'SITE_NOT_FOUND',
          message: 'Établissement introuvable.',
        });
      }

      const [row] = await tx
        .update(sites)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.siteType !== undefined ? { siteType: input.siteType } : {}),
          ...(input.province !== undefined ? { province: input.province } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.commune !== undefined ? { commune: input.commune } : {}),
          ...(input.addressLine !== undefined ? { addressLine: input.addressLine } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.latitude !== undefined
            ? { latitude: input.latitude === null ? null : String(input.latitude) }
            : {}),
          ...(input.longitude !== undefined
            ? { longitude: input.longitude === null ? null : String(input.longitude) }
            : {}),
          ...(input.geofenceRadiusMeters !== undefined
            ? { geofenceRadiusMeters: input.geofenceRadiusMeters }
            : {}),
          ...(input.transportZoneCode !== undefined
            ? { transportZoneCode: input.transportZoneCode }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sites.id, siteId))
        .returning();

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'SITE_UPDATED',
        resourceType: 'site',
        resourceId: siteId,
        siteId,
        beforeState: existing,
        afterState: row,
      });

      return row!;
    });

    return { site: updated };
  }

  @RequirePermissions('organization.departments.read')
  @Get('departments')
  async listDepartments(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    const tenantId = principal.activeTenantId!;
    const scope = getPermissionScope(principal, 'organization.departments.read');
    const rows = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      if (!scope) return [];
      if (scope.allSites) {
        return tx.select().from(departments).orderBy(asc(departments.code));
      }
      const clauses = [];
      if (scope.siteIds.size > 0) {
        clauses.push(isNull(departments.siteId));
        clauses.push(inArray(departments.siteId, Array.from(scope.siteIds)));
      }
      if (scope.departmentIds.size > 0) {
        clauses.push(inArray(departments.id, Array.from(scope.departmentIds)));
      }
      // C-06 : Fail-closed si aucun site ni département effectif n'est rattaché
      if (clauses.length === 0) {
        return [];
      }
      const whereExpr = clauses.length === 1 ? clauses[0]! : or(...clauses);
      return tx.select().from(departments).where(whereExpr).orderBy(asc(departments.code));
    });

    return { departments: rows };
  }

  @RequirePermissions('organization.departments.manage')
  @Post('departments')
  async createDepartment(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(createDepartmentSchema, body);
    const tenantId = principal.activeTenantId!;

    // C-02 : Vérifie le périmètre propre à `organization.departments.manage`
    if (!hasAllSitesForPermission(principal, 'organization.departments.manage')) {
      if (
        !input.siteId ||
        !canAccessSiteForPermission(principal, 'organization.departments.manage', input.siteId)
      ) {
        throw new ForbiddenException({
          code: 'SITE_SCOPE_DENIED',
          message:
            'Votre périmètre pour organization.departments.manage exige de rattacher le département à un établissement autorisé.',
        });
      }
    }

    const created = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      if (input.siteId) {
        const [site] = await tx.select({ id: sites.id }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
        if (!site) {
          throw new NotFoundException({
            code: 'SITE_NOT_FOUND',
            message: 'Établissement de rattachement introuvable dans cette entreprise.',
          });
        }
      }

      const [dup] = await tx
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.tenantId, tenantId), eq(departments.code, input.code)))
        .limit(1);

      if (dup) {
        throw new ConflictException({
          code: 'DEPARTMENT_CODE_EXISTS',
          message: `Le code département "${input.code}" existe déjà.`,
        });
      }

      const deptId = uuidv7();
      const [inserted] = await tx
        .insert(departments)
        .values({
          id: deptId,
          tenantId,
          siteId: input.siteId ?? null,
          parentDepartmentId: input.parentDepartmentId ?? null,
          code: input.code,
          name: input.name,
          status: 'ACTIVE',
        })
        .returning();

      await this.db.appendAuditLog(tx, {
        tenantId,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        actorRole: principal.roleCodes.join(','),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'DEPARTMENT_CREATED',
        resourceType: 'department',
        resourceId: deptId,
        siteId: input.siteId ?? null,
        afterState: inserted,
      });

      return inserted!;
    });

    return { department: created };
  }
}
