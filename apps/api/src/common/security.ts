import net from 'node:net';
import {
  BadRequestException,
  ForbiddenException,
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ZodType, ZodTypeDef } from 'zod';
import type { PermissionCode } from '@nexus-rh/shared-types';
import { isAllowedBrowserOrigin, type AppConfig } from '../config/app-config';

export const IS_PUBLIC_KEY = 'nexus:isPublic';
export const REQUIRE_SUPERADMIN_KEY = 'nexus:requireSuperAdmin';
export const REQUIRED_PERMISSIONS_KEY = 'nexus:requiredPermissions';
export const REQUIRE_MFA_VERIFIED_KEY = 'nexus:requireMfaVerified';
export const ALLOW_PENDING_MFA_SETUP_KEY = 'nexus:allowPendingMfaSetup';

export const REFRESH_COOKIE_NAME = 'nexus_rt';
export const CSRF_HEADER_NAME = 'x-nexus-csrf';
export const CSRF_HEADER_VALUE = '1';

/**
 * Périmètre effectif résolu STRICTEMENT pour une permission donnée (C-02 / C-06).
 * Empêche toute fusion transversale de périmètre entre deux rôles distincts.
 */
export interface PermissionScopeGrant {
  readonly allSites: boolean;
  /** Sites explicitement autorisés via `SELECTED_SITES` sur les rôles portant cette permission. */
  readonly siteIds: ReadonlySet<string>;
  /** Départements autorisés via `OWN_DEPARTMENT` (fail-closed si vide). */
  readonly departmentIds: ReadonlySet<string>;
  /** Dossier employé personnel autorisé via `SELF_ONLY` (fail-closed si null). */
  readonly selfEmployeeId: string | null;
  /** Site de rattachement de l'agent (uniquement pour lecture contextuelle `organization.sites.read`). */
  readonly contextSiteIds: ReadonlySet<string>;
}

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly sessionId: string;
  readonly accessTokenJti: string;
  readonly accessTokenExp: number;
  readonly isPlatformSuperadmin: boolean;
  readonly mfaEnabled: boolean;
  readonly mfaRequired: boolean;
  readonly mfaVerified: boolean;
  readonly activeTenantId: string | null;
  readonly roleCodes: readonly string[];
  readonly permissions: ReadonlySet<string>;
  /** Périmètre granulaire par code de permission (source d'autorité unique C-02/C-06). */
  readonly permissionScopes: ReadonlyMap<string, PermissionScopeGrant>;
  /** Vrai UNIQUEMENT si une même appartenance active porte `TENANT_ADMIN` + `ALL_SITES`. */
  readonly hasGlobalTenantAdminRole: boolean;
  /** Vrai uniquement si TOUTES les permissions actives couvrent `ALL_SITES` (affichage synthèse `/auth/me`). */
  readonly hasAllSitesAccess: boolean;
  /** Union informative des sites explicitement autorisés (ne jamais utiliser seule pour autoriser une action). */
  readonly allowedSiteIds: ReadonlySet<string>;
}

export interface RequestMeta {
  readonly requestId: string;
  readonly ipAddress: string;
  readonly userAgent: string;
}

export interface NexusRequest extends Request {
  principal?: AuthenticatedPrincipal;
  requestId?: string;
  trustedProxyCount?: number;
}

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const RequireSuperAdmin = () => SetMetadata(REQUIRE_SUPERADMIN_KEY, true);
export const RequireMfaVerified = () => SetMetadata(REQUIRE_MFA_VERIFIED_KEY, true);
export const AllowPendingMfaSetup = () => SetMetadata(ALLOW_PENDING_MFA_SETUP_KEY, true);
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

export function getPermissionScope(
  principal: AuthenticatedPrincipal,
  permission: PermissionCode | string,
): PermissionScopeGrant | null {
  if (!principal.permissions.has(permission)) {
    return null;
  }
  return principal.permissionScopes.get(permission) ?? null;
}

export function hasAllSitesForPermission(
  principal: AuthenticatedPrincipal,
  permission: PermissionCode | string,
): boolean {
  const scope = getPermissionScope(principal, permission);
  return Boolean(scope?.allSites);
}

export function canAccessSiteForPermission(
  principal: AuthenticatedPrincipal,
  permission: PermissionCode | string,
  siteId: string,
): boolean {
  const scope = getPermissionScope(principal, permission);
  if (!scope) return false;
  if (scope.allSites) return true;
  return scope.siteIds.has(siteId);
}

export function assertSiteAccessForPermission(
  principal: AuthenticatedPrincipal,
  permission: PermissionCode | string,
  siteId: string,
  customMessage?: string,
): void {
  if (!canAccessSiteForPermission(principal, permission, siteId)) {
    throw new ForbiddenException({
      code: 'SITE_SCOPE_FORBIDDEN',
      message:
        customMessage ??
        `Votre périmètre pour la permission "${permission}" ne couvre pas cet établissement.`,
    });
  }
}

export function canAccessEmployeeForPermission(
  principal: AuthenticatedPrincipal,
  permission: PermissionCode | string,
  employee: {
    readonly id: string;
    readonly primarySiteId: string;
    readonly departmentId: string | null;
  },
): boolean {
  const scope = getPermissionScope(principal, permission);
  if (!scope) return false;
  if (scope.allSites) return true;
  if (scope.siteIds.has(employee.primarySiteId)) return true;
  if (employee.departmentId !== null && scope.departmentIds.has(employee.departmentId)) {
    return true;
  }
  if (scope.selfEmployeeId !== null && employee.id === scope.selfEmployeeId) {
    return true;
  }
  return false;
}

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
    const req = ctx.switchToHttp().getRequest<NexusRequest>();
    if (!req.principal) {
      throw new Error('Principal authentifié manquant sur la requête.');
    }
    return req.principal;
  },
);

export const ReqMeta = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestMeta => {
    const req = ctx.switchToHttp().getRequest<NexusRequest>();
    return extractRequestMeta(req);
  },
);

function normalizeIpLiteral(raw: string | undefined): string | null {
  if (!raw) return null;
  let candidate = raw.trim();
  if (!candidate || candidate.length > 64) return null;
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const v4 = candidate.slice(7);
    if (net.isIPv4(v4)) {
      candidate = v4;
    }
  }
  return net.isIP(candidate) !== 0 ? candidate : null;
}

/**
 * Résout l'adresse IP cliente sans faire confiance aveuglément à `X-Forwarded-For` (D-02) :
 * - `trustedProxyCount === 0` (défaut) : ignore intégralement `X-Forwarded-For` et utilise `socket.remoteAddress`.
 * - `trustedProxyCount === N > 0` : parcourt la chaîne `X-Forwarded-For` de droite à gauche
 *   (`chain[length - N]`), ignorant toute IP forgée en tête par un client malveillant.
 */
export function resolveClientIp(
  socketRemoteAddress: string | undefined,
  forwardedForHeader: string | string[] | undefined,
  trustedProxyCount = 0,
): string {
  const socketIp = normalizeIpLiteral(socketRemoteAddress) ?? 'unknown';
  if (!Number.isInteger(trustedProxyCount) || trustedProxyCount <= 0) {
    return socketIp;
  }

  const rawForwarded = Array.isArray(forwardedForHeader)
    ? forwardedForHeader.join(',')
    : forwardedForHeader;
  if (typeof rawForwarded !== 'string' || rawForwarded.trim() === '') {
    return socketIp;
  }

  const parts = rawForwarded
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return socketIp;
  }

  // En parcourant depuis la droite : chaque proxy de confiance ajoute une entrée en queue.
  // Si la chaîne est plus courte que trustedProxyCount ou contient une entrée invalide dans la
  // portion censée provenir des proxys de confiance, on sélectionne la première IP valide depuis la droite.
  const targetIndex = Math.max(0, parts.length - trustedProxyCount);
  for (let i = parts.length - 1; i >= targetIndex; i--) {
    if (!normalizeIpLiteral(parts[i])) {
      return socketIp;
    }
  }
  return normalizeIpLiteral(parts[targetIndex]) ?? socketIp;
}

export function extractRequestMeta(req: NexusRequest): RequestMeta {
  const ipAddress = resolveClientIp(
    req.socket?.remoteAddress,
    req.headers['x-forwarded-for'],
    req.trustedProxyCount ?? 0,
  );
  return {
    requestId: req.requestId ?? 'unknown',
    ipAddress: ipAddress.slice(0, 64),
    userAgent: String(req.headers['user-agent'] ?? 'unknown').slice(0, 512),
  };
}

/**
 * Vérification anti-CSRF multicouche sur les routes authentifiées par cookie `nexus_rt` (F-03) :
 * 1. En-tête personnalisé obligatoire `X-Nexus-CSRF: 1` (impossible à émettre par formulaire HTML ou navigation cross-site).
 * 2. Si `Origin` (ou à défaut `Referer`) est présent, vérification stricte contre les origines autorisées ou le même hôte.
 */
export function assertCookieCsrfProtection(
  req: Request,
  config: Pick<AppConfig, 'nodeEnv' | 'infraProfile' | 'corsAllowedOrigins'>,
): void {
  const csrfHeader = req.headers[CSRF_HEADER_NAME];
  const csrfValue = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
  if (csrfValue?.trim() !== CSRF_HEADER_VALUE) {
    throw new ForbiddenException({
      code: 'CSRF_PROTECTION_REJECTED',
      message: 'En-tête de protection anti-CSRF manquant ou invalide.',
    });
  }

  const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  const rawReferer = typeof req.headers.referer === 'string' ? req.headers.referer.trim() : '';

  let candidateOrigin: string | null = null;
  if (rawOrigin) {
    candidateOrigin = rawOrigin;
  } else if (rawReferer) {
    try {
      candidateOrigin = new URL(rawReferer).origin;
    } catch {
      throw new ForbiddenException({
        code: 'CSRF_PROTECTION_REJECTED',
        message: 'En-tête Referer invalide refusé par la protection anti-CSRF.',
      });
    }
  }

  if (candidateOrigin) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(candidateOrigin);
    } catch {
      throw new ForbiddenException({
        code: 'CSRF_PROTECTION_REJECTED',
        message: 'Origine de requête invalide refusée par la protection anti-CSRF.',
      });
    }

    const reqHost = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
    const isSameHost =
      Boolean(reqHost) &&
      parsedOrigin.host.toLowerCase() === reqHost &&
      (parsedOrigin.protocol === 'https:' ||
        (config.nodeEnv !== 'production' && parsedOrigin.protocol === 'http:'));

    if (!isSameHost && !isAllowedBrowserOrigin(parsedOrigin.origin, config)) {
      throw new ForbiddenException({
        code: 'CSRF_PROTECTION_REJECTED',
        message: 'Origine cross-site non autorisée sur une opération de session.',
      });
    }
  }
}

export function validateWithZod<TOutput>(
  schema: ZodType<TOutput, ZodTypeDef, unknown>,
  input: unknown,
): TOutput {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    }));
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: details[0]?.message ?? 'Données de requête invalides.',
      details,
    });
  }
  return parsed.data;
}

export function parseCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(eqIdx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function setRefreshTokenCookie(
  res: Response,
  rawToken: string,
  maxAgeSeconds: number,
  secure: boolean,
): void {
  const attributes = [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api/v1/auth',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) {
    attributes.push('Secure');
  }
  res.setHeader('Set-Cookie', attributes.join('; '));
}

export function clearRefreshTokenCookie(res: Response, secure: boolean): void {
  const attributes = [
    `${REFRESH_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api/v1/auth',
    'Max-Age=0',
  ];
  if (secure) {
    attributes.push('Secure');
  }
  res.setHeader('Set-Cookie', attributes.join('; '));
}
