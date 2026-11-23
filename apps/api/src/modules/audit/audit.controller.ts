import { Controller, ForbiddenException, Get, Inject, Query } from '@nestjs/common';
import { NexusDatabase, and, auditLogs, desc, eq } from '@nexus-rh/database';
import { NEXUS_DB } from '../../infra/ports';
import {
  CurrentPrincipal,
  hasAllSitesForPermission,
  type AuthenticatedPrincipal,
} from '../../common/security';

@Controller('audit')
export class AuditController {
  constructor(@Inject(NEXUS_DB) private readonly db: NexusDatabase) {}

  @Get('logs')
  async listLogs(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query('scope') scope?: string,
    @Query('action') action?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(100, Math.max(1, Number(limitRaw ?? 50) || 50));

    if (scope === 'platform') {
      if (!principal.isPlatformSuperadmin) {
        throw new ForbiddenException({
          code: 'SUPERADMIN_REQUIRED',
          message: 'Seul le Super-Administrateur peut consulter la chaîne d’audit plateforme.',
        });
      }
      if (!principal.mfaVerified) {
        throw new ForbiddenException({
          code: 'MFA_STEP_UP_REQUIRED',
          message:
            'Une session MFA vérifiée est obligatoire pour consulter la chaîne d’audit plateforme.',
        });
      }

      const logs = await this.db.withPlatformTransaction(async (tx) => {
        const condition = action
          ? and(eq(auditLogs.chainScope, 'PLATFORM'), eq(auditLogs.action, action))
          : eq(auditLogs.chainScope, 'PLATFORM');
        return tx
          .select()
          .from(auditLogs)
          .where(condition)
          .orderBy(desc(auditLogs.seqNo))
          .limit(limit);
      });

      return { scope: 'platform', logs };
    }

    if (!principal.activeTenantId || !principal.permissions.has('audit.read')) {
      throw new ForbiddenException({
        code: 'AUDIT_PERMISSION_REQUIRED',
        message: 'Permission audit.read sur une entreprise active requise.',
      });
    }
    if (!hasAllSitesForPermission(principal, 'audit.read')) {
      throw new ForbiddenException({
        code: 'ALL_SITES_SCOPE_REQUIRED',
        message:
          'La consultation du journal d’audit d’entreprise exige la permission audit.read sur ALL_SITES.',
      });
    }

    const tenantId = principal.activeTenantId;
    const logs = await this.db.withTenantTransaction(tenantId, principal.userId, async (tx) => {
      // PostgreSQL RLS garantit que seules les entrées de `tenantId` sont visibles
      const condition = action ? eq(auditLogs.action, action) : undefined;
      return condition
        ? tx.select().from(auditLogs).where(condition).orderBy(desc(auditLogs.seqNo)).limit(limit)
        : tx.select().from(auditLogs).orderBy(desc(auditLogs.seqNo)).limit(limit);
    });

    return { scope: 'tenant', tenantId, logs };
  }

  @Get('verify')
  async verifyChain(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query('scope') scope?: string,
  ) {
    if (scope === 'platform') {
      if (!principal.isPlatformSuperadmin) {
        throw new ForbiddenException({
          code: 'SUPERADMIN_REQUIRED',
          message: 'Accès réservé au Super-Administrateur.',
        });
      }
      if (!principal.mfaVerified) {
        throw new ForbiddenException({
          code: 'MFA_STEP_UP_REQUIRED',
          message:
            'Une session MFA vérifiée est obligatoire pour vérifier la chaîne d’audit plateforme.',
        });
      }
      const verification = await this.db.verifyAuditChainScope(null);
      return {
        scope: 'platform',
        verifiedAt: new Date().toISOString(),
        algorithm: 'SHA-256',
        ...verification,
      };
    }

    if (!principal.activeTenantId || !principal.permissions.has('audit.read')) {
      throw new ForbiddenException({
        code: 'AUDIT_PERMISSION_REQUIRED',
        message: 'Permission audit.read sur une entreprise active requise.',
      });
    }
    if (!hasAllSitesForPermission(principal, 'audit.read')) {
      throw new ForbiddenException({
        code: 'ALL_SITES_SCOPE_REQUIRED',
        message:
          'La vérification du journal d’audit d’entreprise exige la permission audit.read sur ALL_SITES.',
      });
    }

    const verification = await this.db.verifyAuditChainScope(principal.activeTenantId);
    return {
      scope: 'tenant',
      tenantId: principal.activeTenantId,
      verifiedAt: new Date().toISOString(),
      algorithm: 'SHA-256',
      ...verification,
    };
  }
}
