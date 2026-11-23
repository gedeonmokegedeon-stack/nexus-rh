import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  createTenantSchema,
  updateBiometricPolicySchema,
  updateTenantProfileSchema,
  updateTenantStatusSchema,
} from '@nexus-rh/shared-types';
import { z } from 'zod';
import {
  CurrentPrincipal,
  ReqMeta,
  RequireMfaVerified,
  RequirePermissions,
  RequireSuperAdmin,
  validateWithZod,
  type AuthenticatedPrincipal,
  type RequestMeta,
} from '../../common/security';
import { TenantsService } from './tenants.service';

@Controller()
export class TenantsController {
  constructor(@Inject(TenantsService) private readonly tenantsService: TenantsService) {}

  @RequireSuperAdmin()
  @RequireMfaVerified()
  @Get('platform/tenants')
  async listPlatformTenants() {
    const items = await this.tenantsService.listPlatformTenants();
    return {
      tenants: items.map(({ encryptionKeyRef: _hidden, ...safe }) => safe),
    };
  }

  @RequireSuperAdmin()
  @RequireMfaVerified()
  @Post('platform/tenants')
  async createTenant(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(createTenantSchema, body);
    const result = await this.tenantsService.createTenant(principal, input, meta);
    const { encryptionKeyRef: _hidden, ...safeTenant } = result.tenant;
    return { tenant: safeTenant, headquartersSite: result.headquartersSite };
  }

  @RequireSuperAdmin()
  @RequireMfaVerified()
  @Patch('platform/tenants/:id/status')
  async updateTenantStatus(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const tenantId = validateWithZod(z.string().uuid('Identifiant tenant invalide.'), id);
    const input = validateWithZod(updateTenantStatusSchema, body);
    const updated = await this.tenantsService.updateTenantStatus(principal, tenantId, input, meta);
    const { encryptionKeyRef: _hidden, ...safeTenant } = updated;
    return { tenant: safeTenant };
  }

  @RequirePermissions('tenant.read')
  @Get('tenant/profile')
  async getProfile(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { tenant: await this.tenantsService.getActiveTenantProfile(principal) };
  }

  @RequirePermissions('tenant.update')
  @Patch('tenant/profile')
  async updateProfile(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(updateTenantProfileSchema, body);
    return { tenant: await this.tenantsService.updateActiveTenantProfile(principal, input, meta) };
  }

  @RequirePermissions('tenant.biometric_policy.manage')
  @RequireMfaVerified()
  @Patch('tenant/biometric-policy')
  async updateBiometricPolicy(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(updateBiometricPolicySchema, body);
    return { tenant: await this.tenantsService.updateBiometricPolicy(principal, input, meta) };
  }
}
