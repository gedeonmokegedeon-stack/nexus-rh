import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode } from '@nexus-rh/crypto-audit';
import { loadAppConfig } from './config/app-config';
import { createNexusApiApp } from './app.factory';

function extractCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  for (const item of list) {
    if (item.startsWith(`${name}=`)) {
      return item.split(';')[0]!;
    }
  }
  return '';
}

function findFullSetCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  return list.find((item) => item.startsWith(`${name}=`)) ?? '';
}

async function enrollAndVerifyTotp(app: INestApplication, initialToken: string): Promise<string> {
  const setup = await request(app.getHttpServer())
    .post('/api/v1/auth/mfa/setup')
    .set('Authorization', `Bearer ${initialToken}`)
    .expect(201);
  const code = generateTotpCode(setup.body.secretBase32);
  const enabled = await request(app.getHttpServer())
    .post('/api/v1/auth/mfa/enable')
    .set('Authorization', `Bearer ${initialToken}`)
    .send({ code })
    .expect(200);
  return enabled.body.accessToken as string;
}

describe('@nexus-rh/api — Intégration Mission 1 (Auth, MFA, Rotation, RLS, RBAC, SoD, Biométrie, Audit)', () => {
  let app: INestApplication;
  let superAdminToken = '';
  let superAdminTotpSecret = '';
  let superAdminRecoveryCodes: string[] = [];

  let tenantAId = '';
  let tenantAKinSiteId = '';
  let tenantALubSiteId = '';
  let adminAToken = '';

  let tenantBId = '';
  let tenantBSiteId = '';
  let adminBToken = '';

  beforeAll(async () => {
    const config = loadAppConfig({
      infraProfile: 'sandbox',
      pgliteDataDir: 'memory://',
    });
    app = await createNexusApiApp(config);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuse catégoriquement le profil sandbox en NODE_ENV=production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => loadAppConfig({ infraProfile: 'sandbox' })).toThrow(/interdit/);
      expect(() => loadAppConfig({ infraProfile: 'production' })).toThrow(/obligatoires/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('expose un état de santé honnête et vérifié (RLS>=10, DEVICE_ONLY, connecteurs SPECIFIED)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.status).toBe('healthy');
    expect(res.body.components.database.forceRlsTablesCount).toBeGreaterThanOrEqual(10);
    expect(res.body.governance.defaultBiometricStoragePolicy).toBe('DEVICE_ONLY');
    expect(res.body.governance.hardcodedPayrollRates).toBe(false);
    expect(
      res.body.governance.biometricConnectors.every(
        (c: { maturity: string; operationalOnRealHardware: boolean }) =>
          c.maturity === 'SPECIFIED' && c.operationalOnRealHardware === false,
      ),
    ).toBe(true);
  });

  it('initialise une seule fois le Super-Admin sur base vierge puis verrouille /auth/bootstrap', async () => {
    const statusBefore = await request(app.getHttpServer())
      .get('/api/v1/auth/bootstrap-status')
      .expect(200);
    expect(statusBefore.body.needsInitialSetup).toBe(true);

    const boot = await request(app.getHttpServer())
      .post('/api/v1/auth/bootstrap')
      .send({
        fullName: 'Super Admin Test',
        email: 'superadmin@nexus-test.invalid',
        password: 'SuperAdmin#2026!Valid',
      })
      .expect(201);

    expect(boot.body.accessToken).toBeTruthy();
    expect(boot.body.mfaSetupRequired).toBe(true);
    superAdminToken = boot.body.accessToken;

    // Seconde tentative -> rejetée 409
    await request(app.getHttpServer())
      .post('/api/v1/auth/bootstrap')
      .send({
        fullName: 'Attaquant',
        email: 'hacker@nexus-test.invalid',
        password: 'Attacker#2026!Valid99',
      })
      .expect(409);

    const statusAfter = await request(app.getHttpServer())
      .get('/api/v1/auth/bootstrap-status')
      .expect(200);
    expect(statusAfter.body.needsInitialSetup).toBe(false);
  });

  it('active la MFA TOTP, révoque le JWT au logout, valide la connexion TOTP et les codes de secours', async () => {
    const setup = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(201);

    superAdminTotpSecret = setup.body.secretBase32;
    expect(setup.body.otpauthUri).toContain('otpauth://totp/');

    const code = generateTotpCode(superAdminTotpSecret);
    const enabled = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/enable')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ code })
      .expect(200);

    expect(enabled.body.enabled).toBe(true);
    expect(enabled.body.recoveryCodes).toHaveLength(8);
    superAdminRecoveryCodes = enabled.body.recoveryCodes;
    superAdminToken = enabled.body.accessToken;

    // Logout -> révocation immédiate du JWT (avec en-tête anti-CSRF obligatoire F-03)
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .set('X-Nexus-CSRF', '1')
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(401);

    // Reconnexion : exige obligatoirement le défi MFA
    const loginStep1 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'superadmin@nexus-test.invalid',
        password: 'SuperAdmin#2026!Valid',
      })
      .expect(200);

    expect(loginStep1.body.status).toBe('MFA_REQUIRED');
    const challengeToken: string = loginStep1.body.mfaChallengeToken;

    // Impossible d'utiliser mfaChallengeToken comme accessToken
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${challengeToken}`)
      .expect(401);

    // Protection anti-rejeu TOTP : le même code à 6 chiffres déjà consommé sur ce pas de 30s est rejeté
    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaChallengeToken: challengeToken, code })
      .expect(401);

    // Validation avec un code de secours à usage unique
    const usedRecovery = superAdminRecoveryCodes[0]!;
    const loginStep2 = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaChallengeToken: challengeToken, code: usedRecovery })
      .expect(200);

    expect(loginStep2.body.status).toBe('AUTHENTICATED');
    superAdminToken = loginStep2.body.accessToken;

    // Protection anti-rejeu du mfaChallengeToken lui-même -> 401
    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaChallengeToken: challengeToken, code: superAdminRecoveryCodes[1]! })
      .expect(401);

    // Un code de secours déjà utilisé ne peut JAMAIS resservir
    const loginRetry = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'superadmin@nexus-test.invalid',
        password: 'SuperAdmin#2026!Valid',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaChallengeToken: loginRetry.body.mfaChallengeToken, code: usedRecovery })
      .expect(401);
  });

  it('effectue la rotation du Refresh Token et révoque toute la famille en cas de réutilisation frauduleuse', async () => {
    const login1 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'superadmin@nexus-test.invalid',
        password: 'SuperAdmin#2026!Valid',
      })
      .expect(200);

    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaChallengeToken: login1.body.mfaChallengeToken,
        code: superAdminRecoveryCodes[1]!,
      })
      .expect(200);

    const fullCookie1 = findFullSetCookie(verified.headers['set-cookie'], 'nexus_rt');
    expect(fullCookie1).toContain('HttpOnly');
    expect(fullCookie1).toContain('SameSite=Strict');
    const cookie1 = extractCookie(verified.headers['set-cookie'], 'nexus_rt');
    expect(cookie1).toContain('nexus_rt=');

    // Rotation légitime : cookie1 -> cookie2 (avec en-tête anti-CSRF obligatoire F-03)
    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie1)
      .set('X-Nexus-CSRF', '1')
      .expect(200);

    const rotatedAccessToken: string = refreshed.body.accessToken;
    const cookie2 = extractCookie(refreshed.headers['set-cookie'], 'nexus_rt');
    expect(cookie2).not.toBe(cookie1);

    // Simulation de vol : rejeu de l'ancien cookie1 -> 401 + révocation immédiate de cookie2 et de sa session !
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie1)
      .set('X-Nexus-CSRF', '1')
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie2)
      .set('X-Nexus-CSRF', '1')
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${rotatedAccessToken}`)
      .expect(401);
  });

  it('provisionne deux entreprises multi-sites (WAT/CAT) et empêche toute fuite inter-tenant', async () => {
    // Provisionnement Entreprise A (Kinshasa UTC+1)
    const createA = await request(app.getHttpServer())
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        slug: 'alpha-rdc-test',
        legalName: 'Alpha RDC Test SARL',
        legalForm: 'SARL',
        sectorCode: 'LOGISTICS',
        rccm: 'CD/KNG/RCCM/26-B-00001',
        idNat: '01-H4901-N00001A',
        taxIdDgi: 'A2600001X',
        cnssEmployerNumber: '1010000100',
        inppEmployerNumber: 'INPP-KIN-0001',
        onemEmployerNumber: 'ONEM-KIN-0001',
        defaultCurrency: 'CDF',
        isDemoTenant: true,
        headquartersSite: {
          code: 'KIN-HQ',
          name: 'Siège Gombe (Test)',
          province: 'Kinshasa',
          city: 'Kinshasa',
          commune: 'Gombe',
          timezone: 'Africa/Kinshasa',
        },
        initialAdmin: {
          fullName: 'Admin Alpha Test',
          email: 'admin.alpha@nexus-test.invalid',
          password: 'AdminAlpha#2026!Valid',
        },
      })
      .expect(201);

    tenantAId = createA.body.tenant.id;
    tenantAKinSiteId = createA.body.headquartersSite.id;
    expect(createA.body.tenant.biometricStoragePolicy).toBe('DEVICE_ONLY');
    expect(createA.body.tenant.centralTemplateStorageEnabled).toBe(false);

    // Provisionnement Entreprise B (Kolwezi UTC+2)
    const createB = await request(app.getHttpServer())
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        slug: 'beta-lualaba-test',
        legalName: 'Beta Lualaba Test SA',
        legalForm: 'SA',
        sectorCode: 'MINING',
        defaultCurrency: 'USD',
        isDemoTenant: true,
        headquartersSite: {
          code: 'KWZ-HQ',
          name: 'Direction Kolwezi (Test)',
          province: 'Lualaba',
          city: 'Kolwezi',
          timezone: 'Africa/Lubumbashi',
        },
        initialAdmin: {
          fullName: 'Admin Beta Test',
          email: 'admin.beta@nexus-test.invalid',
          password: 'AdminBeta#2026!Valid',
        },
      })
      .expect(201);

    tenantBId = createB.body.tenant.id;
    tenantBSiteId = createB.body.headquartersSite.id;

    // Connexion Admin A et Admin B : confinement MFA obligatoire avant enrôlement TOTP (C-03)
    const loginA = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'admin.alpha@nexus-test.invalid', password: 'AdminAlpha#2026!Valid' })
      .expect(200);
    expect(loginA.body.mfaSetupRequired).toBe(true);
    const blockedBeforeMfa = await request(app.getHttpServer())
      .get('/api/v1/sites')
      .set('Authorization', `Bearer ${loginA.body.accessToken}`)
      .expect(403);
    expect(blockedBeforeMfa.body.code).toBe('MFA_SETUP_REQUIRED');
    adminAToken = await enrollAndVerifyTotp(app, loginA.body.accessToken);

    const loginB = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'admin.beta@nexus-test.invalid', password: 'AdminBeta#2026!Valid' })
      .expect(200);
    expect(loginB.body.mfaSetupRequired).toBe(true);
    adminBToken = await enrollAndVerifyTotp(app, loginB.body.accessToken);

    // Admin A ajoute une succursale à Lubumbashi (UTC+2) dans son entreprise
    const addLub = await request(app.getHttpServer())
      .post('/api/v1/sites')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'LUB-01',
        name: 'Agence Lubumbashi (Test)',
        siteType: 'BRANCH',
        province: 'Haut-Katanga',
        city: 'Lubumbashi',
        timezone: 'Africa/Lubumbashi',
        geofenceRadiusMeters: 250,
      })
      .expect(201);
    tenantALubSiteId = addLub.body.site.id;

    // Vérification isolation : Admin A voit exactement ses 2 sites (jamais KWZ-HQ de Beta)
    const sitesA = await request(app.getHttpServer())
      .get('/api/v1/sites')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    expect(sitesA.body.sites.map((s: { code: string }) => s.code)).toEqual(['KIN-HQ', 'LUB-01']);

    // Intrusion 1 : Admin A tente de modifier le site de Beta -> 404 (filtré par PostgreSQL RLS)
    await request(app.getHttpServer())
      .patch(`/api/v1/sites/${tenantBSiteId}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ name: 'Sabotage Inter-Tenant' })
      .expect(404);

    // Intrusion 2 : Admin A tente de basculer son contexte sur Tenant B -> 403
    await request(app.getHttpServer())
      .post('/api/v1/auth/switch-tenant')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ tenantId: tenantBId })
      .expect(403);

    // Intrusion 3 : Admin A tente d'accéder à la console Super-Admin et à l'audit plateforme -> 403
    await request(app.getHttpServer())
      .get('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/audit/logs?scope=platform')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(403);
  });

  it('applique le périmètre par établissement (SiteScope) et bloque les conflits SoD (4 yeux)', async () => {
    const rolesRes = await request(app.getHttpServer())
      .get('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);

    const roleByCode = new Map<string, string>(
      rolesRes.body.roles.map((r: { code: string; id: string }) => [r.code, r.id]),
    );

    // 1. Chef de site limité uniquement à LUB-01
    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'chef.lub@nexus-test.invalid',
        fullName: 'Chef Agence Lubumbashi Test',
        password: 'ChefSite#2026!Valid1',
        roleId: roleByCode.get('SITE_MANAGER'),
        scopeType: 'SELECTED_SITES',
        siteIds: [tenantALubSiteId],
      })
      .expect(201);

    const chefLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'chef.lub@nexus-test.invalid', password: 'ChefSite#2026!Valid1' })
      .expect(200);

    const chefSites = await request(app.getHttpServer())
      .get('/api/v1/sites')
      .set('Authorization', `Bearer ${chefLogin.body.accessToken}`)
      .expect(200);

    expect(chefSites.body.sites).toHaveLength(1);
    expect(chefSites.body.sites[0].code).toBe('LUB-01');
    expect(chefSites.body.sites[0].id).not.toBe(tenantAKinSiteId);

    // Chef de site ne peut ni créer de site ni lire le journal d'audit -> 403
    await request(app.getHttpServer())
      .post('/api/v1/sites')
      .set('Authorization', `Bearer ${chefLogin.body.accessToken}`)
      .send({
        code: 'GOMA-01',
        name: 'Goma',
        province: 'Nord-Kivu',
        city: 'Goma',
        timezone: 'Africa/Lubumbashi',
      })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/audit/logs')
      .set('Authorization', `Bearer ${chefLogin.body.accessToken}`)
      .expect(403);

    // 2. Séparation des tâches (SoD) : cumul PAYROLL_MANAGER + FINANCE_APPROVER interdit (409)
    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'paie.alpha@nexus-test.invalid',
        fullName: 'Gestionnaire Paie Test',
        password: 'PayrollMgr#2026!Valid',
        roleId: roleByCode.get('PAYROLL_MANAGER'),
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    const sodRes = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'paie.alpha@nexus-test.invalid',
        fullName: 'Gestionnaire Paie Test',
        roleId: roleByCode.get('FINANCE_APPROVER'),
        scopeType: 'ALL_SITES',
      })
      .expect(409);
    expect(sodRes.body.code).toBe('SOD_CONFLICT');

    // 3. Création d'un rôle personnalisé violant SoD -> rejeté 409
    await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'INVALID_SUPER_PAYROLL',
        name: 'Rôle interdit',
        permissions: ['payroll.run.calculate', 'payroll.run.approve'],
      })
      .expect(409);

    // 4. Anti-auto-élévation de privilèges par Admin A -> rejeté 403
    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'admin.alpha@nexus-test.invalid',
        fullName: 'Admin Alpha Test',
        roleId: roleByCode.get('FINANCE_APPROVER'),
        scopeType: 'ALL_SITES',
      })
      .expect(403);

    // 5. Anti-escalade par délégation & anti-IDOR horizontal intra-tenant (SiteScope) :
    // Création d'un rôle délégué limité à la gestion de sites/départements/membres sans droits biométriques ni paie
    const delegatedRole = await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'DELEGATED_BRANCH_ADMIN',
        name: 'Admin Délégué Agence',
        permissions: [
          'organization.sites.read',
          'organization.sites.manage',
          'organization.departments.read',
          'organization.departments.manage',
          'rbac.roles.read',
          'rbac.roles.manage',
          'rbac.members.read',
          'rbac.members.manage',
        ],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'delegue.lub@nexus-test.invalid',
        fullName: 'Délégué Lubumbashi Test',
        password: 'DelegueLub#2026!Valid',
        roleId: delegatedRole.body.role.id,
        scopeType: 'SELECTED_SITES',
        siteIds: [tenantALubSiteId],
      })
      .expect(201);

    const delLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'delegue.lub@nexus-test.invalid', password: 'DelegueLub#2026!Valid' })
      .expect(200);
    const delToken: string = delLogin.body.accessToken;

    // 5a. IDOR horizontal : Délégué Lubumbashi tente de modifier le siège Kinshasa -> 403 SITE_SCOPE_DENIED
    const idorSite = await request(app.getHttpServer())
      .patch(`/api/v1/sites/${tenantAKinSiteId}`)
      .set('Authorization', `Bearer ${delToken}`)
      .send({ name: 'Tentative IDOR Kinshasa' })
      .expect(403);
    expect(idorSite.body.code).toBe('SITE_SCOPE_DENIED');

    // 5b. IDOR horizontal : Délégué Lubumbashi tente de créer un département sur Kinshasa ou global -> 403
    await request(app.getHttpServer())
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${delToken}`)
      .send({ code: 'IDOR-KIN', name: 'Dept Interdit', siteId: tenantAKinSiteId })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${delToken}`)
      .send({ code: 'IDOR-GLOBAL', name: 'Dept Global Interdit' })
      .expect(403);

    // 5c. Cas légitime : Délégué Lubumbashi crée un département sur son propre site LUB-01 -> 201
    await request(app.getHttpServer())
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${delToken}`)
      .send({ code: 'OPS-LUB', name: 'Opérations Lubumbashi', siteId: tenantALubSiteId })
      .expect(201);

    // 5d. Escalade de privilèges par délégation : Délégué tente d'attribuer TENANT_ADMIN -> 403
    const escRole = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${delToken}`)
      .send({
        email: 'complice@nexus-test.invalid',
        fullName: 'Complice Escalade',
        password: 'Complice#2026!Valid1',
        roleId: roleByCode.get('TENANT_ADMIN'),
        scopeType: 'SELECTED_SITES',
        siteIds: [tenantALubSiteId],
      })
      .expect(403);
    expect(escRole.body.code).toBe('ROLE_ASSIGNMENT_ESCALATION_FORBIDDEN');

    // 5e. Escalade de périmètre : Délégué tente d'attribuer ALL_SITES ou Kinshasa -> 403
    const escScope = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${delToken}`)
      .send({
        email: 'complice2@nexus-test.invalid',
        fullName: 'Complice Scope',
        password: 'Complice#2026!Valid2',
        roleId: delegatedRole.body.role.id,
        scopeType: 'ALL_SITES',
      })
      .expect(403);
    expect(escScope.body.code).toBe('SITE_SCOPE_ESCALATION_FORBIDDEN');

    // 5f. Escalade par création de rôle personnalisé -> 403
    await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${delToken}`)
      .send({
        code: 'ESCALATED_ROLE',
        name: 'Rôle Escaladé',
        permissions: ['tenant.biometric_policy.manage'],
      })
      .expect(403);

    // 5g. IDOR sur sessions : Délégué tente de révoquer la session d'Admin A -> 404
    const adminSessions = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    const adminSessionId: string = adminSessions.body.sessions[0].id;
    await request(app.getHttpServer())
      .delete(`/api/v1/auth/sessions/${adminSessionId}`)
      .set('Authorization', `Bearer ${delToken}`)
      .expect(404);
  });

  it('exige MFA vérifiée + autorisation juridique pour modifier la politique biométrique DEVICE_ONLY', async () => {
    // Un rôle personnalisé disposant de tenant.biometric_policy.manage sans MFA active -> 403 MFA_STEP_UP_REQUIRED
    const bioRole = await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'LEGAL_BIO_OFFICER',
        name: 'Référent Conformité Biométrique',
        permissions: ['tenant.read', 'tenant.biometric_policy.manage'],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'dpo.alpha@nexus-test.invalid',
        fullName: 'DPO Alpha Sans MFA',
        password: 'DpoAlpha#2026!Valid1',
        roleId: bioRole.body.role.id,
        scopeType: 'ALL_SITES',
        mfaRequired: false,
      })
      .expect(201);

    const dpoLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'dpo.alpha@nexus-test.invalid', password: 'DpoAlpha#2026!Valid1' })
      .expect(200);

    const noMfa = await request(app.getHttpServer())
      .patch('/api/v1/tenant/biometric-policy')
      .set('Authorization', `Bearer ${dpoLogin.body.accessToken}`)
      .send({
        policy: 'ENCRYPTED_CENTRAL_SYNC',
        centralTemplateStorageEnabled: true,
        legalAuthorizationRef: 'APD-RDC-2026-TEST-01',
        reason: 'Demande test sans MFA active',
      })
      .expect(403);
    expect(noMfa.body.code).toBe('MFA_STEP_UP_REQUIRED');

    // C-04 : SuperAdmin ne peut PAS basculer silencieusement sur Tenant A sans délégation client
    const silentSwitch = await request(app.getHttpServer())
      .post('/api/v1/auth/switch-tenant')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ tenantId: tenantAId })
      .expect(403);
    expect(silentSwitch.body.code).toBe('TENANT_ACCESS_DENIED');

    // Admin A (MFA vérifiée) sans référence juridique -> rejet 400 VALIDATION_ERROR
    await request(app.getHttpServer())
      .patch('/api/v1/tenant/biometric-policy')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        policy: 'ENCRYPTED_CENTRAL_SYNC',
        centralTemplateStorageEnabled: true,
        reason: 'Tentative sans référence juridique valide',
      })
      .expect(400);

    // Vérifier que le profil reste strictement DEVICE_ONLY
    const profile = await request(app.getHttpServer())
      .get('/api/v1/tenant/profile')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    expect(profile.body.tenant.biometricStoragePolicy).toBe('DEVICE_ONLY');
    expect(profile.body.tenant.centralTemplateStorageEnabled).toBe(false);
  });

  it('suspend immédiatement les accès lors de la suspension d’un tenant et verrouille après 5 échecs de mot de passe', async () => {
    // Suspension de Tenant B -> session d'Admin B immédiatement invalidée
    await request(app.getHttpServer())
      .patch(`/api/v1/platform/tenants/${tenantBId}/status`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ status: 'SUSPENDED', reason: 'Test de suspension administrative' })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/sites')
      .set('Authorization', `Bearer ${adminBToken}`)
      .expect(401);

    // Verrouillage anti-force brute après 5 mauvais mots de passe
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'chef.lub@nexus-test.invalid', password: 'MauvaisMotDePasse!' })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'chef.lub@nexus-test.invalid', password: 'ChefSite#2026!Valid1' })
      .expect(429);
  });

  it('vérifie cryptographiquement à 100 % les chaînes d’audit SHA-256 (plateforme et entreprise)', async () => {
    const verifyPlatform = await request(app.getHttpServer())
      .get('/api/v1/audit/verify?scope=platform')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(200);

    expect(verifyPlatform.body.valid).toBe(true);
    expect(verifyPlatform.body.checkedCount).toBeGreaterThanOrEqual(8);

    const verifyTenantA = await request(app.getHttpServer())
      .get('/api/v1/audit/verify')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);

    expect(verifyTenantA.body.valid).toBe(true);
    expect(verifyTenantA.body.tenantId).toBe(tenantAId);
    expect(verifyTenantA.body.checkedCount).toBeGreaterThanOrEqual(4);

    const logsA = await request(app.getHttpServer())
      .get('/api/v1/audit/logs')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);

    // Toutes les entrées retournées appartiennent exclusivement à Tenant A
    expect(
      logsA.body.logs.every((entry: { tenantId: string }) => entry.tenantId === tenantAId),
    ).toBe(true);
  });
});
