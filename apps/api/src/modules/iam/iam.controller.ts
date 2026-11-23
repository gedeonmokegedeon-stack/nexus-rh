import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  bootstrapSuperAdminSchema,
  enableMfaSchema,
  loginSchema,
  switchTenantSchema,
  verifyMfaLoginSchema,
} from '@nexus-rh/shared-types';
import { z } from 'zod';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../infra/ports';
import {
  AllowPendingMfaSetup,
  CurrentPrincipal,
  Public,
  REFRESH_COOKIE_NAME,
  ReqMeta,
  assertCookieCsrfProtection,
  clearRefreshTokenCookie,
  parseCookie,
  setRefreshTokenCookie,
  validateWithZod,
  type AuthenticatedPrincipal,
  type RequestMeta,
} from '../../common/security';
import { IamService } from './iam.service';

@Controller('auth')
export class IamController {
  constructor(
    @Inject(IamService) private readonly iamService: IamService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('bootstrap-status')
  async getBootstrapStatus() {
    return this.iamService.getBootstrapStatus();
  }

  @Public()
  @Post('bootstrap')
  async bootstrap(
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = validateWithZod(bootstrapSuperAdminSchema, body);
    const session = await this.iamService.bootstrapFirstSuperAdmin(input, meta);
    setRefreshTokenCookie(
      res,
      session.refreshToken,
      this.config.security.refreshTtlSeconds,
      this.config.security.cookieSecure,
    );
    return {
      status: 'AUTHENTICATED',
      accessToken: session.accessToken,
      expiresInSeconds: session.expiresInSeconds,
      activeTenantId: session.activeTenantId,
      mfaSetupRequired: session.mfaSetupRequired,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = validateWithZod(loginSchema, body);
    const result = await this.iamService.login(input, meta);
    if (result.status === 'MFA_REQUIRED') {
      return result;
    }

    setRefreshTokenCookie(
      res,
      result.refreshToken,
      this.config.security.refreshTtlSeconds,
      this.config.security.cookieSecure,
    );
    return {
      status: 'AUTHENTICATED',
      accessToken: result.accessToken,
      expiresInSeconds: result.expiresInSeconds,
      activeTenantId: result.activeTenantId,
      mfaSetupRequired: result.mfaSetupRequired,
    };
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = validateWithZod(verifyMfaLoginSchema, body);
    const session = await this.iamService.verifyMfaLogin(input, meta);
    setRefreshTokenCookie(
      res,
      session.refreshToken,
      this.config.security.refreshTtlSeconds,
      this.config.security.cookieSecure,
    );
    return {
      status: 'AUTHENTICATED',
      accessToken: session.accessToken,
      expiresInSeconds: session.expiresInSeconds,
      activeTenantId: session.activeTenantId,
      mfaSetupRequired: session.mfaSetupRequired,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertCookieCsrfProtection(req, this.config);

    const rawToken = parseCookie(req, REFRESH_COOKIE_NAME);
    if (!rawToken) {
      throw new UnauthorizedException({
        code: 'REFRESH_COOKIE_MISSING',
        message: 'Aucune session active trouvée.',
      });
    }

    try {
      const session = await this.iamService.refreshSession(rawToken, meta);
      setRefreshTokenCookie(
        res,
        session.refreshToken,
        this.config.security.refreshTtlSeconds,
        this.config.security.cookieSecure,
      );
      return {
        accessToken: session.accessToken,
        expiresInSeconds: session.expiresInSeconds,
        activeTenantId: session.activeTenantId,
        mfaSetupRequired: session.mfaSetupRequired,
      };
    } catch (err) {
      clearRefreshTokenCookie(res, this.config.security.cookieSecure);
      throw err;
    }
  }

  @AllowPendingMfaSetup()
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertCookieCsrfProtection(req, this.config);
    await this.iamService.logout(principal, meta);
    clearRefreshTokenCookie(res, this.config.security.cookieSecure);
    return { loggedOut: true };
  }

  @AllowPendingMfaSetup()
  @Get('me')
  async getMe(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.iamService.getMe(principal);
  }

  @AllowPendingMfaSetup()
  @Post('switch-tenant')
  @HttpCode(200)
  async switchTenant(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(switchTenantSchema, body);
    return this.iamService.switchActiveTenant(principal, input, meta);
  }

  @AllowPendingMfaSetup()
  @Post('mfa/setup')
  async setupMfa(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.iamService.setupMfa(principal);
  }

  @AllowPendingMfaSetup()
  @Post('mfa/enable')
  @HttpCode(200)
  async enableMfa(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(enableMfaSchema, body);
    return this.iamService.enableMfa(principal, input, meta);
  }

  @AllowPendingMfaSetup()
  @Get('sessions')
  async listSessions(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { sessions: await this.iamService.listActiveSessions(principal) };
  }

  @AllowPendingMfaSetup()
  @Delete('sessions/:sessionId')
  async revokeSession(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('sessionId') sessionId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    const validId = validateWithZod(z.string().uuid('Identifiant de session invalide.'), sessionId);
    await this.iamService.revokeSession(principal, validId, meta);
    return { revoked: true };
  }
}
