import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_GENESIS_HASH,
  BoundedConcurrencyLimiter,
  PasswordHasherOverloadedError,
  assertStrongPin,
  buildTotpOtpAuthUri,
  computeAuditEntryHash,
  computeTenantBlindIndex,
  decryptEnvelope,
  encryptEnvelope,
  generateEd25519KeyPair,
  generateOpaqueRefreshToken,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  hashPassword,
  hashPin,
  hashRecoveryCode,
  issueSignedBadgeQrToken,
  maskSensitiveValue,
  performDummyPasswordVerify,
  redactSensitiveFields,
  signEdDsaJwt,
  uuidv7,
  verifyAuditChain,
  verifyEdDsaJwt,
  verifyPassword,
  verifyPin,
  verifySignedBadgeQrToken,
  verifyTotpCode,
  type AccessTokenClaims,
  type MfaChallengeClaims,
  type StoredAuditChainEntry,
} from './index';
import { detectSodConflicts, SYSTEM_ROLES } from '@nexus-rh/shared-types';

describe('@nexus-rh/crypto-audit — Fondations cryptographiques & audit', () => {
  it('génère des UUIDv7 valides et strictement ordonnés temporellement', () => {
    const id1 = uuidv7(1_700_000_000_000);
    const id2 = uuidv7(1_700_000_001_000);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id1 < id2).toBe(true);
  });

  it('hache et vérifie les mots de passe en Argon2id (64 MiB)', async () => {
    const hash = await hashPassword('NexusRH#2026!Secure');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=65536,t=3,p=1');
    expect(await verifyPassword(hash, 'NexusRH#2026!Secure')).toBe(true);
    expect(await verifyPassword(hash, 'NexusRH#2026!Wrong')).toBe(false);
    await expect(hashPassword('trop-court')).rejects.toThrow();
  });

  it('rejette les codes PIN triviaux et hache les PIN valides en Argon2id', async () => {
    expect(() => assertStrongPin('123456')).toThrow();
    expect(() => assertStrongPin('000000')).toThrow();
    expect(() => assertStrongPin('199012', ['1990'])).toThrow();
    expect(() => assertStrongPin('12345')).toThrow();

    const pinHash = await hashPin('482917', ['1990']);
    expect(await verifyPin(pinHash, '482917')).toBe(true);
    expect(await verifyPin(pinHash, '482918')).toBe(false);
  });

  it('chiffre en enveloppe AES-256-GCM par tenant et bloque tout déchiffrement inter-tenant ou altéré', () => {
    const masterKek = crypto.randomBytes(32);
    const tenantA = uuidv7();
    const tenantB = uuidv7();
    const recordId = uuidv7();

    const env = encryptEnvelope(masterKek, 'CD-BANK-000192837465-USD', {
      tenantScope: tenantA,
      keyRef: 'kek-v1',
      purpose: 'bank_account',
      recordId,
    });

    expect(env.ciphertextB64).not.toContain('000192837465');

    // Déchiffrement légitime par Tenant A
    const decrypted = decryptEnvelope(masterKek, env, {
      tenantScope: tenantA,
      keyRef: 'kek-v1',
      purpose: 'bank_account',
      recordId,
    });
    expect(decrypted.toString('utf8')).toBe('CD-BANK-000192837465-USD');

    // Tentative de déchiffrement par Tenant B -> rejet cryptographique obligatoire
    expect(() =>
      decryptEnvelope(masterKek, env, {
        tenantScope: tenantB,
        keyRef: 'kek-v1',
        purpose: 'bank_account',
        recordId,
      }),
    ).toThrow();

    // Tentative de détournement de finalité (AAD purpose) -> rejet
    expect(() =>
      decryptEnvelope(masterKek, env, {
        tenantScope: tenantA,
        keyRef: 'kek-v1',
        purpose: 'mfa_secret',
        recordId,
      }),
    ).toThrow();

    // Altération d'un seul bit du texte chiffré -> rejet par le tag GCM
    const buf = Buffer.from(env.ciphertextB64, 'base64');
    buf[0] = (buf[0] ?? 0) ^ 0x01;
    expect(() =>
      decryptEnvelope(
        masterKek,
        { ...env, ciphertextB64: buf.toString('base64') },
        { tenantScope: tenantA, keyRef: 'kek-v1', purpose: 'bank_account', recordId },
      ),
    ).toThrow();
  });

  it('signe et vérifie les JWT Ed25519 (EdDSA) et empêche la confusion mfa_challenge / access et alg:none', () => {
    const kp = generateEd25519KeyPair();
    const now = 1_763_390_000;

    const { token: accessToken } = signEdDsaJwt<AccessTokenClaims>(
      {
        typ: 'access',
        sub: uuidv7(),
        sid: uuidv7(),
        tid: uuidv7(),
        sa: false,
        mfa: true,
        iss: 'nexus-rh',
        aud: 'nexus-rh-app',
      },
      kp.privateKeyDerB64,
      900,
      now,
    );

    const verified = verifyEdDsaJwt<AccessTokenClaims>(accessToken, kp.publicKeyDerB64, {
      typ: 'access',
      iss: 'nexus-rh',
      aud: 'nexus-rh-app',
      nowSeconds: now + 100,
    });
    expect(verified.typ).toBe('access');
    expect(verified.mfa).toBe(true);

    // Expiration respectée
    expect(() =>
      verifyEdDsaJwt<AccessTokenClaims>(accessToken, kp.publicKeyDerB64, {
        typ: 'access',
        iss: 'nexus-rh',
        aud: 'nexus-rh-app',
        nowSeconds: now + 901,
      }),
    ).toThrow(/expiré/);

    // Jeton mfa_challenge refusé comme access token
    const { token: mfaToken } = signEdDsaJwt<MfaChallengeClaims>(
      {
        typ: 'mfa_challenge',
        sub: uuidv7(),
        iss: 'nexus-rh',
        aud: 'nexus-rh-app',
      },
      kp.privateKeyDerB64,
      300,
      now,
    );
    expect(() =>
      verifyEdDsaJwt<AccessTokenClaims>(mfaToken, kp.publicKeyDerB64, {
        typ: 'access',
        iss: 'nexus-rh',
        aud: 'nexus-rh-app',
        nowSeconds: now + 10,
      }),
    ).toThrow(/Type de jeton/);

    // Attaque alg: none rejetée
    const fakeHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payloadPart = accessToken.split('.')[1];
    expect(() =>
      verifyEdDsaJwt<AccessTokenClaims>(`${fakeHeader}.${payloadPart}.aa`, kp.publicKeyDerB64, {
        typ: 'access',
        iss: 'nexus-rh',
        aud: 'nexus-rh-app',
        nowSeconds: now + 10,
      }),
    ).toThrow(/Algorithme/);

    // Refresh token opaque
    const rt = generateOpaqueRefreshToken();
    expect(rt.rawToken.length).toBeGreaterThanOrEqual(42);
    expect(rt.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('génère et vérifie les codes TOTP MFA (RFC 6238), bloque le rejeu et valide les codes de secours', () => {
    const secret = generateTotpSecret();
    const nowMs = 1_763_390_010_000;
    const uri = buildTotpOtpAuthUri({
      secretBase32: secret,
      accountEmail: 'securite@exemple.cd',
      issuer: 'NEXUS RH',
    });
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${secret}`);

    const code = generateTotpCode(secret, nowMs);
    expect(code).toMatch(/^\d{6}$/);

    const firstCheck = verifyTotpCode(secret, code, { nowMs });
    expect(firstCheck.valid).toBe(true);
    expect(firstCheck.matchedStep).not.toBeNull();

    // Protection anti-rejeu du même code TOTP sur le même pas de 30s
    const replayCheck = verifyTotpCode(secret, code, {
      nowMs,
      lastUsedStep: firstCheck.matchedStep,
    });
    expect(replayCheck.valid).toBe(false);

    // Codes de secours
    const userId = uuidv7();
    const { plainCodes, hashedCodes } = generateRecoveryCodes(userId);
    expect(plainCodes).toHaveLength(8);
    expect(hashedCodes).toContain(hashRecoveryCode(userId, plainCodes[0]!));
    expect(hashedCodes).not.toContain(hashRecoveryCode(uuidv7(), plainCodes[0]!));
  });

  it('expurge les secrets et détecte toute altération ou suppression dans la chaîne SHA-256 d’audit', () => {
    const redacted = redactSensitiveFields({
      email: 'agent@exemple.cd',
      passwordHash: '$argon2id$secret',
      nested: { biometricTemplate: 'raw', role: 'HR_MANAGER' },
    }) as { email: string; passwordHash: string; nested: { biometricTemplate: string; role: string } };
    expect(redacted.passwordHash).toBe('[EXPURGÉ]');
    expect(redacted.nested.biometricTemplate).toBe('[EXPURGÉ]');
    expect(redacted.nested.role).toBe('HR_MANAGER');

    const scope = uuidv7();
    const e1Base = {
      id: uuidv7(),
      chainScope: scope,
      actorType: 'USER',
      actorId: uuidv7(),
      action: 'TENANT_CREATED',
      resourceType: 'tenant',
      resourceId: scope,
      reason: null,
      beforeState: null,
      afterState: { slug: 'alpha' },
      occurredAtIso: '2026-11-17T10:00:00.000Z',
      prevHash: AUDIT_GENESIS_HASH,
    };
    const e1: StoredAuditChainEntry = {
      ...e1Base,
      seqNo: 1,
      entryHash: computeAuditEntryHash(e1Base),
    };
    const e2Base = {
      ...e1Base,
      id: uuidv7(),
      action: 'SITE_CREATED',
      resourceType: 'site',
      afterState: { code: 'KIN-HQ', timezone: 'Africa/Kinshasa' },
      occurredAtIso: '2026-11-17T10:05:00.000Z',
      prevHash: e1.entryHash,
    };
    const e2: StoredAuditChainEntry = {
      ...e2Base,
      seqNo: 2,
      entryHash: computeAuditEntryHash(e2Base),
    };

    expect(verifyAuditChain([e1, e2]).valid).toBe(true);

    // Altération d'une valeur -> échec immédiat
    const tampered: StoredAuditChainEntry = { ...e1, afterState: { slug: 'falsifie' } };
    const resTampered = verifyAuditChain([tampered, e2]);
    expect(resTampered.valid).toBe(false);
    expect(resTampered.brokenAtSeqNo).toBe('1');

    // Suppression de la première entrée -> rupture prev_hash détectée
    const resDeleted = verifyAuditChain([e2]);
    expect(resDeleted.valid).toBe(false);
    expect(resDeleted.brokenAtSeqNo).toBe('2');
  });

  it('vérifie qu’aucun rôle standard système ne viole la séparation des tâches (SoD) et détecte les cumuls interdits', () => {
    for (const role of SYSTEM_ROLES) {
      expect(detectSodConflicts(role.permissions)).toEqual([]);
    }
    const payrollMgr = SYSTEM_ROLES.find((r) => r.code === 'PAYROLL_MANAGER')!;
    const financeApprover = SYSTEM_ROLES.find((r) => r.code === 'FINANCE_APPROVER')!;
    const conflicts = detectSodConflicts([
      ...payrollMgr.permissions,
      ...financeApprover.permissions,
    ]);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts.map((c) => c.code)).toContain('SOD_PAYROLL_CALC_VS_APPROVE');
  });

  it('calcule des index aveugles HMAC isolés par tenant et masque les identifiants sensibles RH (Mission 2)', () => {
    const masterKek = crypto.randomBytes(32);
    const tenantA = uuidv7();
    const tenantB = uuidv7();

    const idxA1 = computeTenantBlindIndex(masterKek, tenantA, 'kek-a', 'cnss_number', 'cnss-884-219');
    const idxA2 = computeTenantBlindIndex(masterKek, tenantA, 'kek-a', 'cnss_number', 'CNSS 884 219');
    const idxB = computeTenantBlindIndex(masterKek, tenantB, 'kek-b', 'cnss_number', 'CNSS-884-219');
    const idxOtherField = computeTenantBlindIndex(
      masterKek,
      tenantA,
      'kek-a',
      'identity_doc_number',
      'CNSS-884-219',
    );

    expect(idxA1).toBe(idxA2);
    expect(idxA1).not.toBe(idxB); // Zéro corrélation inter-entreprises
    expect(idxA1).not.toBe(idxOtherField); // Séparation de domaine par champ
    expect(maskSensitiveValue('CD98000123456789', 4)).toBe('••••••••6789');

    const redacted = redactSensitiveFields({
      matricule: 'KIN-2026-00001',
      cnssNumber: 'CNSS-884-219',
      identityDocNumber: 'NN123456789',
      baseSalary: '1500.00',
      qrPayload: 'NXRH1.secret',
      pin: '482915',
    }) as Record<string, string>;
    expect(redacted.matricule).toBe('KIN-2026-00001');
    expect(redacted.cnssNumber).toBe('[EXPURGÉ]');
    expect(redacted.identityDocNumber).toBe('[EXPURGÉ]');
    expect(redacted.baseSalary).toBe('[EXPURGÉ]');
    expect(redacted.qrPayload).toBe('[EXPURGÉ]');
    expect(redacted.pin).toBe('[EXPURGÉ]');
  });

  it('émet et vérifie des jetons QR de badge signés HMAC-SHA256 par tenant et rejette toute falsification (Mission 2)', () => {
    const masterKek = crypto.randomBytes(32);
    const tenantA = uuidv7();
    const tenantB = uuidv7();
    const badgeId = uuidv7();

    const issued = issueSignedBadgeQrToken({
      masterKek,
      tenantId: tenantA,
      keyRef: 'kek-a',
      badgeId,
    });
    expect(issued.qrPayload.startsWith(`NXRH1.${tenantA}.${badgeId}.`)).toBe(true);
    expect(issued.qrTokenHash).toHaveLength(64);

    const ok = verifySignedBadgeQrToken({
      masterKek,
      expectedTenantId: tenantA,
      keyRef: 'kek-a',
      rawQrPayload: issued.qrPayload,
    });
    expect(ok).toEqual({
      valid: true,
      badgeId: badgeId.toLowerCase(),
      qrTokenHash: issued.qrTokenHash,
    });

    // Rejet inter-tenant
    expect(
      verifySignedBadgeQrToken({
        masterKek,
        expectedTenantId: tenantB,
        keyRef: 'kek-b',
        rawQrPayload: issued.qrPayload,
      }).valid,
    ).toBe(false);

    // Rejet falsification 1 caractère
    const tampered = `${issued.qrPayload.slice(0, -1)}${issued.qrPayload.endsWith('A') ? 'B' : 'A'}`;
    expect(
      verifySignedBadgeQrToken({
        masterKek,
        expectedTenantId: tenantA,
        keyRef: 'kek-a',
        rawQrPayload: tampered,
      }).valid,
    ).toBe(false);
  });

  it('borne strictement la concurrence Argon2id (D-05) et exécute le hachage factice anti-oracle (D-03)', async () => {
    const limiter = new BoundedConcurrencyLimiter(2, 2);
    let peak = 0;
    const resolvers: Array<() => void> = [];

    const spawnBlocking = (id: string) =>
      limiter.run(async () => {
        peak = Math.max(peak, limiter.inFlight);
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        return id;
      });

    // 2 actifs + 2 en file d'attente = capacité maximale atteinte
    const t1 = spawnBlocking('t1');
    const t2 = spawnBlocking('t2');
    const t3 = spawnBlocking('t3');
    const t4 = spawnBlocking('t4');

    expect(limiter.inFlight).toBe(2);
    expect(limiter.queued).toBe(2);

    // 5e requête simultanée rejetée immédiatement sans épuisement mémoire
    await expect(limiter.run(async () => 't5')).rejects.toBeInstanceOf(
      PasswordHasherOverloadedError,
    );

    // Libération ordonnée sans fuite de jeton
    while (resolvers.length > 0 || limiter.inFlight > 0) {
      const next = resolvers.shift();
      if (next) next();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await Promise.all([t1, t2, t3, t4])).toEqual(['t1', 't2', 't3', 't4']);
    expect(peak).toBe(2);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.queued).toBe(0);

    // D-03 : Vérification Argon2id factice réelle (64 MiB) sans exception sur entrées inconnues ou longues
    const start = Date.now();
    await performDummyPasswordVerify('MotDePasseInconnu#2026!');
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    await expect(performDummyPasswordVerify('x'.repeat(250))).resolves.toBeUndefined();
  });
});
