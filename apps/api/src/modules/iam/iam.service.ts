import crypto from 'node:crypto';
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
  buildTotpOtpAuthUri,
  decryptEnvelope,
  encryptEnvelope,
  generateOpaqueRefreshToken,
  generateRecoveryCodes,
  generateTotpSecret,
  hashOpaqueToken,
  hashPassword,
  hashRecoveryCode,
  performDummyPasswordVerify,
  sha256Hex,
  signEdDsaJwt,
  uuidv7,
  verifyEdDsaJwt,
  verifyPassword,
  verifyTotpCode,
  type AccessTokenClaims,
  type EnvelopeCiphertext,
  type MfaChallengeClaims,
} from '@nexus-rh/crypto-audit';
import {
  NexusDatabase,
  and,
  desc,
  eq,
  gt,
  isNull,
  lte,
  mfaFactors,
  or,
  roles,
  sql,
  tenantMemberships,
  tenants,
  userSessions,
  users,
} from '@nexus-rh/database';
import {
  MANDATORY_MFA_TENANT_ROLE_CODES,
  type BootstrapSuperAdminInput,
  type EnableMfaInput,
  type LoginInput,
  type SwitchTenantInput,
  type VerifyMfaLoginInput,
} from '@nexus-rh/shared-types';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG, CACHE_LOCK_PORT, NEXUS_DB, type CacheLockPort } from '../../infra/ports';
import type { AuthenticatedPrincipal, RequestMeta } from '../../common/security';

const MANDATORY_MFA_ROLE_SET = new Set<string>(MANDATORY_MFA_TENANT_ROLE_CODES);

export interface IssuedSessionResult {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly refreshToken: string;
  readonly activeTenantId: string | null;
  readonly mfaSetupRequired: boolean;
}

export type LoginResult =
  | {
      readonly status: 'MFA_REQUIRED';
      readonly mfaChallengeToken: string;
      readonly expiresInSeconds: number;
    }
  | ({ readonly status: 'AUTHENTICATED' } & IssuedSessionResult);

@Injectable()
export class IamService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NEXUS_DB) private readonly db: NexusDatabase,
    @Inject(CACHE_LOCK_PORT) private readonly cache: CacheLockPort,
  ) {}

  async getBootstrapStatus(): Promise<{ needsInitialSetup: boolean }> {
    const count = await this.db.withPlatformTransaction(async (tx) => {
      const rows = await tx.select({ id: users.id }).from(users).limit(1);
      return rows.length;
    });
    return { needsInitialSetup: count === 0 };
  }

  /**
   * Création unique du tout premier Super-Administrateur sur une base vierge.
   * Verrouillée atomiquement et désactivée définitivement dès qu'un utilisateur existe.
   */
  async bootstrapFirstSuperAdmin(
    input: BootstrapSuperAdminInput,
    meta: RequestMeta,
  ): Promise<IssuedSessionResult> {
    const lock = await this.cache.acquireLock('platform:bootstrap', 30);
    if (!lock) {
      throw new ConflictException({
        code: 'BOOTSTRAP_IN_PROGRESS',
        message: 'Initialisation déjà en cours.',
      });
    }

    try {
      const passwordHash = await hashPassword(input.password);
      const userId = uuidv7();

      await this.db.withPlatformTransaction(async (tx) => {
        const existing = await tx.select({ id: users.id }).from(users).limit(1);
        if (existing.length > 0) {
          throw new ConflictException({
            code: 'BOOTSTRAP_ALREADY_COMPLETED',
            message: 'La plateforme est déjà initialisée. Cet assistant est définitivement désactivé.',
          });
        }

        await tx.insert(users).values({
          id: userId,
          email: input.email.toLowerCase(),
          passwordHash,
          fullName: input.fullName,
          isPlatformSuperadmin: true,
          mfaRequired: true,
          mfaEnabled: false,
          lastLoginAt: new Date(),
          status: 'ACTIVE',
        });

        await this.db.appendAuditLog(tx, {
          tenantId: null,
          actorType: 'SUPERADMIN',
          actorId: userId,
          actorEmail: input.email.toLowerCase(),
          actorRole: 'SUPER_ADMIN',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          action: 'PLATFORM_SUPERADMIN_BOOTSTRAPPED',
          resourceType: 'user',
          resourceId: userId,
          afterState: {
            email: input.email.toLowerCase(),
            fullName: input.fullName,
            isPlatformSuperadmin: true,
            mfaRequired: true,
          },
        });
      });

      return this.issueSession({
        userId,
        isPlatformSuperadmin: true,
        mfaVerified: false,
        mfaSetupRequired: true,
        requestedTenantId: null,
        meta,
      });
    } finally {
      await this.cache.releaseLock('platform:bootstrap', lock);
    }
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
    // Limitation de débit par IP (protection anti-force brute)
    const rate = await this.cache.incrementWithWindow(`rl:login:ip:${meta.ipAddress}`, 60);
    if (rate.count > 20) {
      throw new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Trop de tentatives de connexion. Réessayez dans ${rate.ttlSeconds} s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const email = input.email.toLowerCase();
    // D-02 : Limitation de débit secondaire par compte (haché) contre le password spraying multi-IP
    const accountRateKey = `rl:login:acct:${sha256Hex(email).slice(0, 32)}`;
    const accountRate = await this.cache.incrementWithWindow(accountRateKey, 300);
    if (accountRate.count > 10) {
      throw new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Trop de tentatives sur ce compte. Réessayez dans ${accountRate.ttlSeconds} s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.db.withPlatformTransaction(async (tx) => {
      const [found] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      return found ?? null;
    });

    if (!user) {
      // D-03 : Vérification Argon2id factice (64 MiB) éliminant l'oracle temporel d'énumération
      await performDummyPasswordVerify(input.password);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Identifiants invalides.',
      });
    }

    if (user.status === 'DISABLED') {
      await performDummyPasswordVerify(input.password);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Identifiants invalides.',
      });
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await performDummyPasswordVerify(input.password);
      const remainingMin = Math.max(
        1,
        Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000),
      );
      throw new HttpException(
        {
          code: 'ACCOUNT_TEMPORARILY_LOCKED',
          message: `Compte temporairement verrouillé par sécurité. Réessayez dans ${remainingMin} minute(s).`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const validPassword = await verifyPassword(user.passwordHash, input.password);
    if (!validPassword) {
      const maxAttempts = this.config.security.maxFailedLoginAttempts;
      const lockUntilIso = new Date(
        Date.now() + this.config.security.lockoutMinutes * 60_000,
      ).toISOString();

      // D-03 : Incrément et verrouillage SQL strictement atomiques (aucune course read-modify-write)
      await this.db.withPlatformTransaction(async (tx) => {
        const now = new Date();
        const [updated] = await tx
          .update(users)
          .set({
            failedLoginCount: sql`${users.failedLoginCount} + 1`,
            lockedUntil: sql`CASE WHEN ${users.failedLoginCount} + 1 >= ${maxAttempts} THEN ${lockUntilIso}::timestamptz ELSE ${users.lockedUntil} END`,
            updatedAt: now,
          })
          .where(eq(users.id, user.id))
          .returning({
            failedLoginCount: users.failedLoginCount,
            lockedUntil: users.lockedUntil,
          });

        const nextCount = updated?.failedLoginCount ?? user.failedLoginCount + 1;
        const shouldLock = Boolean(
          updated?.lockedUntil && updated.lockedUntil.getTime() > now.getTime(),
        );

        await this.db.appendAuditLog(tx, {
          tenantId: null,
          actorType: 'USER',
          actorId: user.id,
          actorEmail: user.email,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          action: shouldLock ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_LOGIN_FAILED',
          resourceType: 'user',
          resourceId: user.id,
          afterState: { failedLoginCount: nextCount, locked: shouldLock },
        });
      });

      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Identifiants invalides.',
      });
    }

    // Réinitialisation atomique conditionnelle : échoue si un verrouillage concurrent vient d'intervenir
    const unlockedReset = await this.db.withPlatformTransaction(async (tx) => {
      const now = new Date();
      const rows = await tx
        .update(users)
        .set({
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(users.id, user.id),
            eq(users.status, 'ACTIVE'),
            or(isNull(users.lockedUntil), lte(users.lockedUntil, now)),
          ),
        )
        .returning({ id: users.id });
      return rows.length > 0;
    });

    if (!unlockedReset) {
      throw new HttpException(
        {
          code: 'ACCOUNT_TEMPORARILY_LOCKED',
          message: 'Compte temporairement verrouillé par sécurité. Réessayez ultérieurement.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.cache.del(accountRateKey);

    // Si la MFA TOTP est activée, ne PAS émettre de session : émettre un défi MFA de 5 min
    if (user.mfaEnabled) {
      const { token } = signEdDsaJwt<MfaChallengeClaims>(
        {
          typ: 'mfa_challenge',
          sub: user.id,
          iss: this.config.security.jwtIssuer,
          aud: this.config.security.jwtAudience,
        },
        this.config.security.jwtPrivateKeyDerB64,
        300,
      );
      return {
        status: 'MFA_REQUIRED',
        mfaChallengeToken: token,
        expiresInSeconds: 300,
      };
    }

    const session = await this.issueSession({
      userId: user.id,
      isPlatformSuperadmin: user.isPlatformSuperadmin,
      mfaVerified: false,
      mfaSetupRequired: user.mfaRequired && !user.mfaEnabled,
      requestedTenantId: null,
      meta,
    });

    await this.db.withPlatformTransaction(async (tx) => {
      await this.db.appendAuditLog(tx, {
        tenantId: null,
        actorType: user.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: user.id,
        actorEmail: user.email,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'AUTH_LOGIN_SUCCESS',
        resourceType: 'session',
        afterState: { mfaVerified: false, activeTenantId: session.activeTenantId },
      });
    });

    return { status: 'AUTHENTICATED', ...session };
  }

  async verifyMfaLogin(input: VerifyMfaLoginInput, meta: RequestMeta): Promise<IssuedSessionResult> {
    let challenge: MfaChallengeClaims;
    try {
      challenge = verifyEdDsaJwt<MfaChallengeClaims>(
        input.mfaChallengeToken,
        this.config.security.jwtPublicKeyDerB64,
        {
          typ: 'mfa_challenge',
          iss: this.config.security.jwtIssuer,
          aud: this.config.security.jwtAudience,
        },
      );
    } catch {
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_INVALID',
        message: 'Défi MFA expiré ou invalide. Veuillez recommencer la connexion.',
      });
    }

    const rate = await this.cache.incrementWithWindow(`rl:mfa:${challenge.sub}`, 300);
    if (rate.count > 8) {
      throw new HttpException(
        { code: 'MFA_RATE_LIMIT', message: 'Trop de tentatives MFA. Veuillez patienter.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const alreadyUsed = await this.cache.get(`mfa:challenge:used:${challenge.jti}`);
    if (alreadyUsed) {
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_ALREADY_USED',
        message: 'Ce défi MFA a déjà été utilisé.',
      });
    }

    const user = await this.verifyUserMfaCodeOrRecovery(challenge.sub, input.code, meta);
    await this.cache.set(`mfa:challenge:used:${challenge.jti}`, '1', 300);

    return this.issueSession({
      userId: user.id,
      isPlatformSuperadmin: user.isPlatformSuperadmin,
      mfaVerified: true,
      mfaSetupRequired: false,
      requestedTenantId: null,
      meta,
    });
  }

  async setupMfa(principal: AuthenticatedPrincipal): Promise<{
    secretBase32: string;
    otpauthUri: string;
    issuer: string;
  }> {
    if (principal.mfaEnabled) {
      throw new ConflictException({
        code: 'MFA_ALREADY_ENABLED',
        message: 'L’authentification multi-facteurs (MFA) est déjà active sur votre compte.',
      });
    }

    // D-03 : Limitation de débit sur l'initialisation TOTP
    const setupRate = await this.cache.incrementWithWindow(
      `rl:mfa-setup:${principal.userId}`,
      600,
    );
    if (setupRate.count > 6) {
      throw new HttpException(
        {
          code: 'MFA_RATE_LIMIT',
          message: `Trop d’initialisations MFA. Réessayez dans ${setupRate.ttlSeconds} s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const secretBase32 = generateTotpSecret();
    const factorId = uuidv7();
    const envelope = encryptEnvelope(this.config.security.masterKek, secretBase32, {
      tenantScope: 'platform',
      keyRef: 'mfa-v1',
      purpose: 'mfa_secret',
      recordId: principal.userId,
    });

    await this.db.withPlatformTransaction(async (tx) => {
      await tx
        .delete(mfaFactors)
        .where(and(eq(mfaFactors.userId, principal.userId), eq(mfaFactors.factorType, 'TOTP')));

      await tx.insert(mfaFactors).values({
        id: factorId,
        userId: principal.userId,
        factorType: 'TOTP',
        encryptedPayload: envelope,
        verifiedAt: null,
      });
    });

    return {
      secretBase32,
      issuer: this.config.security.mfaIssuerName,
      otpauthUri: buildTotpOtpAuthUri({
        secretBase32,
        accountEmail: principal.email,
        issuer: this.config.security.mfaIssuerName,
      }),
    };
  }

  async enableMfa(
    principal: AuthenticatedPrincipal,
    input: EnableMfaInput,
    meta: RequestMeta,
  ): Promise<{
    enabled: true;
    recoveryCodes: string[];
    accessToken: string;
    expiresInSeconds: number;
  }> {
    if (principal.mfaEnabled) {
      throw new ConflictException({
        code: 'MFA_ALREADY_ENABLED',
        message: 'L’authentification multi-facteurs (MFA) est déjà active sur votre compte.',
      });
    }

    // D-03 : Limitation anti-force brute sur la validation du code TOTP d'activation
    const enableRate = await this.cache.incrementWithWindow(
      `rl:mfa-enable:${principal.userId}`,
      300,
    );
    if (enableRate.count > 6) {
      throw new HttpException(
        {
          code: 'MFA_RATE_LIMIT',
          message: `Trop de tentatives de validation MFA. Réessayez dans ${enableRate.ttlSeconds} s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const factor = await this.db.withPlatformTransaction(async (tx) => {
      const [found] = await tx
        .select()
        .from(mfaFactors)
        .where(and(eq(mfaFactors.userId, principal.userId), eq(mfaFactors.factorType, 'TOTP')))
        .limit(1);
      return found ?? null;
    });

    if (!factor) {
      throw new BadRequestException({
        code: 'MFA_SETUP_NOT_STARTED',
        message: 'Veuillez d’abord initialiser la configuration MFA (/auth/mfa/setup).',
      });
    }

    const secretBase32 = decryptEnvelope(
      this.config.security.masterKek,
      factor.encryptedPayload as EnvelopeCiphertext,
      {
        tenantScope: 'platform',
        keyRef: 'mfa-v1',
        purpose: 'mfa_secret',
        recordId: principal.userId,
      },
    ).toString('utf8');

    const check = verifyTotpCode(secretBase32, input.code);
    if (!check.valid || check.matchedStep === null) {
      throw new BadRequestException({
        code: 'MFA_INVALID_CODE',
        message: 'Code TOTP incorrect. Vérifiez l’heure de votre appareil et réessayez.',
      });
    }

    const { plainCodes, hashedCodes } = generateRecoveryCodes(principal.userId, 8);

    await this.db.withPlatformTransaction(async (tx) => {
      await tx
        .update(mfaFactors)
        .set({
          verifiedAt: new Date(),
          lastUsedAt: new Date(),
          lastUsedStep: check.matchedStep,
        })
        .where(eq(mfaFactors.id, factor.id));

      await tx
        .delete(mfaFactors)
        .where(
          and(eq(mfaFactors.userId, principal.userId), eq(mfaFactors.factorType, 'RECOVERY_CODES')),
        );

      await tx.insert(mfaFactors).values({
        id: uuidv7(),
        userId: principal.userId,
        factorType: 'RECOVERY_CODES',
        encryptedPayload: { remainingHashes: hashedCodes },
        verifiedAt: new Date(),
      });

      await tx
        .update(users)
        .set({ mfaEnabled: true, updatedAt: new Date() })
        .where(eq(users.id, principal.userId));

      await tx
        .update(userSessions)
        .set({ mfaVerified: true })
        .where(eq(userSessions.id, principal.sessionId));

      await this.db.appendAuditLog(tx, {
        tenantId: null,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'AUTH_MFA_ENABLED',
        resourceType: 'user',
        resourceId: principal.userId,
        afterState: { factorType: 'TOTP', recoveryCodesGenerated: plainCodes.length },
      });
    });

    // Révoque l'ancien jeton d'accès pré-MFA avant d'émettre le jeton élevé `mfa: true`
    const remainingTtl = Math.max(1, principal.accessTokenExp - Math.floor(Date.now() / 1000));
    await this.cache.set(`jwt:revoked:${principal.accessTokenJti}`, '1', remainingTtl);
    await this.cache.del(`rl:mfa-enable:${principal.userId}`);

    const { token: accessToken } = signEdDsaJwt<AccessTokenClaims>(
      {
        typ: 'access',
        sub: principal.userId,
        sid: principal.sessionId,
        tid: principal.activeTenantId,
        sa: principal.isPlatformSuperadmin,
        mfa: true,
        iss: this.config.security.jwtIssuer,
        aud: this.config.security.jwtAudience,
      },
      this.config.security.jwtPrivateKeyDerB64,
      this.config.security.accessTtlSeconds,
    );

    return {
      enabled: true,
      recoveryCodes: plainCodes,
      accessToken,
      expiresInSeconds: this.config.security.accessTtlSeconds,
    };
  }

  /**
   * Rotation stricte du Refresh Token avec détection automatique de vol/réutilisation :
   * si un jeton déjà révoqué est représenté, TOUTE la famille `token_family_id` est révoquée.
   */
  async refreshSession(rawRefreshToken: string, meta: RequestMeta): Promise<IssuedSessionResult> {
    // D-03 : Limitation de débit sur le renouvellement de session par cookie
    const refreshRate = await this.cache.incrementWithWindow(
      `rl:refresh:ip:${meta.ipAddress}`,
      300,
    );
    if (refreshRate.count > 30) {
      throw new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Trop de renouvellements de session. Réessayez dans ${refreshRate.ttlSeconds} s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const tokenHash = hashOpaqueToken(rawRefreshToken);

    const existing = await this.db.withPlatformTransaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(userSessions)
        .where(eq(userSessions.refreshTokenHash, tokenHash))
        .limit(1);
      return row ?? null;
    });

    if (!existing) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Session expirée ou invalide.',
      });
    }

    if (existing.revokedAt) {
      // ALERTE DE SÉCURITÉ : réutilisation d'un refresh token déjà tourné -> révocation de la famille !
      await this.db.withPlatformTransaction(async (tx) => {
        await tx
          .update(userSessions)
          .set({ revokedAt: new Date(), revokeReason: 'TOKEN_REUSE_DETECTED' })
          .where(
            and(
              eq(userSessions.tokenFamilyId, existing.tokenFamilyId),
              isNull(userSessions.revokedAt),
            ),
          );

        await this.db.appendAuditLog(tx, {
          tenantId: null,
          actorType: 'SYSTEM',
          actorId: existing.userId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          action: 'AUTH_REFRESH_TOKEN_REUSE_DETECTED',
          resourceType: 'session_family',
          resourceId: existing.tokenFamilyId,
          afterState: { revokedEntireFamily: true },
        });
      });

      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REUSE_DETECTED',
        message: 'Anomalie de sécurité détectée : toutes les sessions associées ont été révoquées.',
      });
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Session expirée. Veuillez vous reconnecter.',
      });
    }

    const rotated = generateOpaqueRefreshToken();
    const newSessionId = uuidv7();
    const newExpiresAt = new Date(Date.now() + this.config.security.refreshTtlSeconds * 1000);

    const user = await this.db.withPlatformTransaction(async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, existing.userId)).limit(1);
      if (!u || u.status !== 'ACTIVE') {
        throw new UnauthorizedException({ code: 'ACCOUNT_INACTIVE', message: 'Compte inactif.' });
      }

      // Consommation atomique (anti-TOCTOU) : une seule requête parallèle peut tourner le jeton
      const claimed = await tx
        .update(userSessions)
        .set({ revokedAt: new Date(), revokeReason: 'ROTATED' })
        .where(and(eq(userSessions.id, existing.id), isNull(userSessions.revokedAt)))
        .returning({ id: userSessions.id });

      if (claimed.length === 0) {
        await tx
          .update(userSessions)
          .set({ revokedAt: new Date(), revokeReason: 'TOKEN_REUSE_DETECTED' })
          .where(
            and(
              eq(userSessions.tokenFamilyId, existing.tokenFamilyId),
              isNull(userSessions.revokedAt),
            ),
          );

        await this.db.appendAuditLog(tx, {
          tenantId: null,
          actorType: 'SYSTEM',
          actorId: existing.userId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          action: 'AUTH_REFRESH_TOKEN_REUSE_DETECTED',
          resourceType: 'session_family',
          resourceId: existing.tokenFamilyId,
          afterState: { revokedEntireFamily: true, concurrentReplay: true },
        });
        return null;
      }

      await tx.insert(userSessions).values({
        id: newSessionId,
        userId: u.id,
        activeTenantId: existing.activeTenantId,
        refreshTokenHash: rotated.tokenHash,
        tokenFamilyId: existing.tokenFamilyId,
        mfaVerified: Boolean(existing.mfaVerified && u.mfaEnabled),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt: newExpiresAt,
      });

      let tenantMfaRequired = false;
      if (existing.activeTenantId && !u.mfaEnabled) {
        const now = new Date();
        const mems = await tx
          .select({ mfaRequired: tenantMemberships.mfaRequired, roleCode: roles.code })
          .from(tenantMemberships)
          .leftJoin(roles, eq(tenantMemberships.roleId, roles.id))
          .where(
            and(
              eq(tenantMemberships.tenantId, existing.activeTenantId),
              eq(tenantMemberships.userId, u.id),
              eq(tenantMemberships.status, 'ACTIVE'),
              or(isNull(tenantMemberships.expiresAt), gt(tenantMemberships.expiresAt, now)),
            ),
          );
        tenantMfaRequired = mems.some(
          (m) => m.mfaRequired || (m.roleCode !== null && MANDATORY_MFA_ROLE_SET.has(m.roleCode)),
        );
      }

      return { u, tenantMfaRequired };
    });

    if (!user) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REUSE_DETECTED',
        message: 'Anomalie de sécurité détectée : toutes les sessions associées ont été révoquées.',
      });
    }

    const effectiveMfaVerified = Boolean(existing.mfaVerified && user.u.mfaEnabled);
    const { token: accessToken } = signEdDsaJwt<AccessTokenClaims>(
      {
        typ: 'access',
        sub: user.u.id,
        sid: newSessionId,
        tid: existing.activeTenantId,
        sa: user.u.isPlatformSuperadmin,
        mfa: effectiveMfaVerified,
        iss: this.config.security.jwtIssuer,
        aud: this.config.security.jwtAudience,
      },
      this.config.security.jwtPrivateKeyDerB64,
      this.config.security.accessTtlSeconds,
    );

    const requiresMfa =
      user.u.isPlatformSuperadmin || user.u.mfaRequired || user.tenantMfaRequired;
    return {
      accessToken,
      expiresInSeconds: this.config.security.accessTtlSeconds,
      refreshToken: rotated.rawToken,
      activeTenantId: existing.activeTenantId,
      mfaSetupRequired: requiresMfa && !user.u.mfaEnabled,
    };
  }

  async logout(principal: AuthenticatedPrincipal, meta: RequestMeta): Promise<void> {
    const remainingTtl = Math.max(1, principal.accessTokenExp - Math.floor(Date.now() / 1000));
    await this.cache.set(`jwt:revoked:${principal.accessTokenJti}`, '1', remainingTtl);

    await this.db.withPlatformTransaction(async (tx) => {
      await tx
        .update(userSessions)
        .set({ revokedAt: new Date(), revokeReason: 'USER_LOGOUT' })
        .where(eq(userSessions.id, principal.sessionId));

      await this.db.appendAuditLog(tx, {
        tenantId: null,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'AUTH_LOGOUT',
        resourceType: 'session',
        resourceId: principal.sessionId,
      });
    });
  }

  async switchActiveTenant(
    principal: AuthenticatedPrincipal,
    input: SwitchTenantInput,
    meta: RequestMeta,
  ): Promise<{ accessToken: string; expiresInSeconds: number; activeTenantId: string }> {
    await this.db.withPlatformTransaction(async (tx) => {
      const [tenant] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);

      if (!tenant || (tenant.status !== 'ACTIVE' && tenant.status !== 'TRIAL')) {
        throw new ForbiddenException({
          code: 'TENANT_UNAVAILABLE',
          message: 'Entreprise introuvable ou inactive.',
        });
      }

      // C-04 : Même un SUPER_ADMIN ne peut basculer sur une entreprise cliente sans délégation
      // temporaire explicite, active et non expirée accordée par le client (SECURITY_POLICY.md § 5.2).
      const now = new Date();
      const memberships = await tx
        .select({
          id: tenantMemberships.id,
          expiresAt: tenantMemberships.expiresAt,
        })
        .from(tenantMemberships)
        .where(
          and(
            eq(tenantMemberships.tenantId, input.tenantId),
            eq(tenantMemberships.userId, principal.userId),
            eq(tenantMemberships.status, 'ACTIVE'),
            or(isNull(tenantMemberships.expiresAt), gt(tenantMemberships.expiresAt, now)),
          ),
        )
        .limit(1);

      if (memberships.length === 0) {
        throw new ForbiddenException({
          code: 'TENANT_ACCESS_DENIED',
          message: principal.isPlatformSuperadmin
            ? 'Accès refusé : le Super-Administrateur ne peut pas accéder aux données d’une entreprise sans délégation support temporaire active et auditée accordée par le client.'
            : 'Vous n’êtes pas autorisé à accéder à cette entreprise.',
        });
      }

      await tx
        .update(userSessions)
        .set({ activeTenantId: input.tenantId })
        .where(eq(userSessions.id, principal.sessionId));

      await this.db.appendAuditLog(tx, {
        tenantId: null,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'AUTH_TENANT_CONTEXT_SWITCHED',
        resourceType: 'tenant',
        resourceId: input.tenantId,
        beforeState: { activeTenantId: principal.activeTenantId },
        afterState: { activeTenantId: input.tenantId, tenantSlug: tenant.slug },
      });
    });

    // Révocation immédiate de l'ancien jeton d'accès
    const remainingTtl = Math.max(1, principal.accessTokenExp - Math.floor(Date.now() / 1000));
    await this.cache.set(`jwt:revoked:${principal.accessTokenJti}`, '1', remainingTtl);

    const { token: accessToken } = signEdDsaJwt<AccessTokenClaims>(
      {
        typ: 'access',
        sub: principal.userId,
        sid: principal.sessionId,
        tid: input.tenantId,
        sa: principal.isPlatformSuperadmin,
        mfa: principal.mfaVerified,
        iss: this.config.security.jwtIssuer,
        aud: this.config.security.jwtAudience,
      },
      this.config.security.jwtPrivateKeyDerB64,
      this.config.security.accessTtlSeconds,
    );

    return {
      accessToken,
      expiresInSeconds: this.config.security.accessTtlSeconds,
      activeTenantId: input.tenantId,
    };
  }

  async getMe(principal: AuthenticatedPrincipal) {
    const now = new Date();
    // C-04 : Liste strictement limitée aux entreprises où l'utilisateur détient une appartenance
    // active et non expirée (la console plateforme dispose de /api/v1/platform/tenants).
    const accessibleTenants = await this.db.withPlatformTransaction(async (tx) => {
      const rows = await tx
        .selectDistinct({
          id: tenants.id,
          slug: tenants.slug,
          legalName: tenants.legalName,
          tradeName: tenants.tradeName,
          status: tenants.status,
          defaultCurrency: tenants.defaultCurrency,
          biometricStoragePolicy: tenants.biometricStoragePolicy,
          isDemoTenant: tenants.isDemoTenant,
        })
        .from(tenantMemberships)
        .innerJoin(tenants, eq(tenantMemberships.tenantId, tenants.id))
        .where(
          and(
            eq(tenantMemberships.userId, principal.userId),
            eq(tenantMemberships.status, 'ACTIVE'),
            or(isNull(tenantMemberships.expiresAt), gt(tenantMemberships.expiresAt, now)),
            sql`${tenants.status} IN ('ACTIVE', 'TRIAL')`,
          ),
        );
      return rows;
    });

    const activeTenant =
      accessibleTenants.find((t) => t.id === principal.activeTenantId) ?? null;

    return {
      user: {
        id: principal.userId,
        email: principal.email,
        fullName: principal.fullName,
        isPlatformSuperadmin: principal.isPlatformSuperadmin,
        mfaEnabled: principal.mfaEnabled,
        mfaRequired: principal.mfaRequired,
        mfaVerified: principal.mfaVerified,
        mfaSetupRequired: principal.mfaRequired && !principal.mfaEnabled,
      },
      sessionId: principal.sessionId,
      activeTenant,
      accessibleTenants,
      roles: principal.roleCodes,
      permissions: Array.from(principal.permissions).sort(),
      siteAccess: {
        allSites: principal.hasAllSitesAccess,
        allowedSiteIds: Array.from(principal.allowedSiteIds),
      },
    };
  }

  async listActiveSessions(principal: AuthenticatedPrincipal) {
    return this.db.withPlatformTransaction(async (tx) => {
      const rows = await tx
        .select({
          id: userSessions.id,
          activeTenantId: userSessions.activeTenantId,
          mfaVerified: userSessions.mfaVerified,
          ipAddress: userSessions.ipAddress,
          userAgent: userSessions.userAgent,
          createdAt: userSessions.createdAt,
          expiresAt: userSessions.expiresAt,
        })
        .from(userSessions)
        .where(
          and(
            eq(userSessions.userId, principal.userId),
            isNull(userSessions.revokedAt),
            sql`${userSessions.expiresAt} > NOW()`,
          ),
        )
        .orderBy(desc(userSessions.createdAt));

      return rows.map((r) => ({
        ...r,
        isCurrent: r.id === principal.sessionId,
      }));
    });
  }

  async revokeSession(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.db.withPlatformTransaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(userSessions)
        .where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, principal.userId)))
        .limit(1);

      if (!target) {
        throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Session introuvable.' });
      }

      await tx
        .update(userSessions)
        .set({ revokedAt: new Date(), revokeReason: 'USER_MANUAL_REVOKE' })
        .where(eq(userSessions.id, sessionId));

      await this.db.appendAuditLog(tx, {
        tenantId: null,
        actorType: principal.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: principal.userId,
        actorEmail: principal.email,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'AUTH_SESSION_REVOKED',
        resourceType: 'session',
        resourceId: sessionId,
      });
    });
  }

  private async verifyUserMfaCodeOrRecovery(userId: string, rawCode: string, meta: RequestMeta) {
    return this.db.withPlatformTransaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException({ code: 'ACCOUNT_INACTIVE', message: 'Compte inactif.' });
      }

      const trimmed = rawCode.trim();

      if (/^\d{6}$/.test(trimmed)) {
        const [totpFactor] = await tx
          .select()
          .from(mfaFactors)
          .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.factorType, 'TOTP')))
          .limit(1);

        if (!totpFactor || !totpFactor.verifiedAt) {
          throw new UnauthorizedException({ code: 'MFA_NOT_CONFIGURED', message: 'MFA invalide.' });
        }

        const secretBase32 = decryptEnvelope(
          this.config.security.masterKek,
          totpFactor.encryptedPayload as EnvelopeCiphertext,
          {
            tenantScope: 'platform',
            keyRef: 'mfa-v1',
            purpose: 'mfa_secret',
            recordId: userId,
          },
        ).toString('utf8');

        const result = verifyTotpCode(secretBase32, trimmed, {
          lastUsedStep: totpFactor.lastUsedStep,
        });
        if (!result.valid || result.matchedStep === null) {
          throw new UnauthorizedException({
            code: 'MFA_CODE_INVALID',
            message: 'Code MFA invalide ou déjà utilisé.',
          });
        }

        await tx
          .update(mfaFactors)
          .set({ lastUsedAt: new Date(), lastUsedStep: result.matchedStep })
          .where(eq(mfaFactors.id, totpFactor.id));

        await this.db.appendAuditLog(tx, {
          tenantId: null,
          actorType: user.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
          actorId: user.id,
          actorEmail: user.email,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          action: 'AUTH_MFA_VERIFIED',
          resourceType: 'user',
          resourceId: user.id,
          afterState: { method: 'TOTP' },
        });
        return user;
      }

      // Vérification d'un code de secours à usage unique
      const [recoveryFactor] = await tx
        .select()
        .from(mfaFactors)
        .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.factorType, 'RECOVERY_CODES')))
        .limit(1);

      const remaining =
        (recoveryFactor?.encryptedPayload as { remainingHashes?: string[] } | undefined)
          ?.remainingHashes ?? [];
      const candidateBuf = Buffer.from(hashRecoveryCode(userId, trimmed), 'hex');
      let matchIdx = -1;
      for (let i = 0; i < remaining.length; i++) {
        const storedBuf = Buffer.from(remaining[i]!, 'hex');
        if (storedBuf.length === candidateBuf.length && crypto.timingSafeEqual(storedBuf, candidateBuf)) {
          matchIdx = i;
        }
      }

      if (!recoveryFactor || matchIdx === -1) {
        throw new UnauthorizedException({
          code: 'MFA_CODE_INVALID',
          message: 'Code MFA ou code de secours invalide.',
        });
      }

      const updatedHashes = remaining.filter((_, i) => i !== matchIdx);
      await tx
        .update(mfaFactors)
        .set({
          encryptedPayload: { remainingHashes: updatedHashes },
          lastUsedAt: new Date(),
        })
        .where(eq(mfaFactors.id, recoveryFactor.id));

      await this.db.appendAuditLog(tx, {
        tenantId: null,
        actorType: user.isPlatformSuperadmin ? 'SUPERADMIN' : 'USER',
        actorId: user.id,
        actorEmail: user.email,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        action: 'AUTH_MFA_RECOVERY_CODE_USED',
        resourceType: 'user',
        resourceId: user.id,
        afterState: { remainingRecoveryCodes: updatedHashes.length },
      });

      return user;
    });
  }

  private async issueSession(params: {
    userId: string;
    isPlatformSuperadmin: boolean;
    mfaVerified: boolean;
    mfaSetupRequired: boolean;
    requestedTenantId: string | null;
    meta: RequestMeta;
  }): Promise<IssuedSessionResult> {
    const refresh = generateOpaqueRefreshToken();
    const sessionId = uuidv7();
    const tokenFamilyId = uuidv7();
    const expiresAt = new Date(Date.now() + this.config.security.refreshTtlSeconds * 1000);

    const { activeTenantId, tenantMfaRequired } = await this.db.withPlatformTransaction(
      async (tx) => {
        const now = new Date();
        let resolvedTenantId = params.requestedTenantId;

        if (!resolvedTenantId) {
          // C-04 : Attache uniquement une appartenance explicite active et non expirée
          // (jamais d'auto-attachement silencieux d'un tenant client pour SUPER_ADMIN).
          // N-04 : Si l'utilisateur n'a pas encore configuré la MFA et dispose d'un tenant
          // sans MFA obligatoire, privilégie ce tenant afin de ne jamais contaminer l'autre tenant.
          const userTenants = await tx
            .select({
              tenantId: tenantMemberships.tenantId,
              mfaRequired: tenantMemberships.mfaRequired,
              roleCode: roles.code,
            })
            .from(tenantMemberships)
            .innerJoin(tenants, eq(tenantMemberships.tenantId, tenants.id))
            .leftJoin(roles, eq(tenantMemberships.roleId, roles.id))
            .where(
              and(
                eq(tenantMemberships.userId, params.userId),
                eq(tenantMemberships.status, 'ACTIVE'),
                or(isNull(tenantMemberships.expiresAt), gt(tenantMemberships.expiresAt, now)),
                sql`${tenants.status} IN ('ACTIVE', 'TRIAL')`,
              ),
            )
            .orderBy(desc(tenantMemberships.createdAt));

          if (userTenants.length > 0) {
            const byTenant = new Map<string, boolean>();
            for (const row of userTenants) {
              const reqMfa =
                row.mfaRequired ||
                (row.roleCode !== null && MANDATORY_MFA_ROLE_SET.has(row.roleCode));
              byTenant.set(row.tenantId, (byTenant.get(row.tenantId) ?? false) || reqMfa);
            }
            if (!params.mfaVerified) {
              const nonMfaTenant = Array.from(byTenant.entries()).find(([, req]) => !req);
              resolvedTenantId = nonMfaTenant?.[0] ?? userTenants[0]!.tenantId;
            } else {
              resolvedTenantId = userTenants[0]!.tenantId;
            }
          }
        }

        let requiresTenantMfa = false;
        if (resolvedTenantId) {
          const activeMems = await tx
            .select({
              mfaRequired: tenantMemberships.mfaRequired,
              roleCode: roles.code,
            })
            .from(tenantMemberships)
            .leftJoin(roles, eq(tenantMemberships.roleId, roles.id))
            .where(
              and(
                eq(tenantMemberships.tenantId, resolvedTenantId),
                eq(tenantMemberships.userId, params.userId),
                eq(tenantMemberships.status, 'ACTIVE'),
                or(isNull(tenantMemberships.expiresAt), gt(tenantMemberships.expiresAt, now)),
              ),
            );
          requiresTenantMfa = activeMems.some(
            (m) => m.mfaRequired || (m.roleCode !== null && MANDATORY_MFA_ROLE_SET.has(m.roleCode)),
          );
        }

        await tx.insert(userSessions).values({
          id: sessionId,
          userId: params.userId,
          activeTenantId: resolvedTenantId,
          refreshTokenHash: refresh.tokenHash,
          tokenFamilyId,
          mfaVerified: params.mfaVerified,
          ipAddress: params.meta.ipAddress,
          userAgent: params.meta.userAgent,
          expiresAt,
        });

        return { activeTenantId: resolvedTenantId, tenantMfaRequired: requiresTenantMfa };
      },
    );

    const { token: accessToken } = signEdDsaJwt<AccessTokenClaims>(
      {
        typ: 'access',
        sub: params.userId,
        sid: sessionId,
        tid: activeTenantId,
        sa: params.isPlatformSuperadmin,
        mfa: params.mfaVerified,
        iss: this.config.security.jwtIssuer,
        aud: this.config.security.jwtAudience,
      },
      this.config.security.jwtPrivateKeyDerB64,
      this.config.security.accessTtlSeconds,
    );

    const effectiveMfaSetupRequired =
      !params.mfaVerified && (params.mfaSetupRequired || tenantMfaRequired);

    return {
      accessToken,
      expiresInSeconds: this.config.security.accessTtlSeconds,
      refreshToken: refresh.rawToken,
      activeTenantId,
      mfaSetupRequired: effectiveMfaSetupRequired,
    };
  }
}
