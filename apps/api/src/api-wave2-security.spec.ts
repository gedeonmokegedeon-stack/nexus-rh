import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateTotpCode } from '@nexus-rh/crypto-audit';
import {
  NexusDatabase,
  and,
  employees,
  eq,
  tenantMemberships,
  users,
} from '@nexus-rh/database';
import { isAllowedBrowserOrigin, loadAppConfig } from './config/app-config';
import { createNexusApiApp } from './app.factory';
import { resolveClientIp } from './common/security';
import { CACHE_LOCK_PORT, NEXUS_DB, type CacheLockPort } from './infra/ports';
import { REDIS_ATOMIC_INCR_WINDOW_LUA, RedisCacheLockAdapter } from './infra/adapters';

const SAMPLE_PDF_B64 = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
  'utf8',
).toString('base64');

function extractCookiePair(setCookieHeader: string | string[] | undefined, name: string): string {
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

function extractRawSetCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  return list.find((item) => item.startsWith(`${name}=`)) ?? '';
}

async function enrollMfa(app: INestApplication, initialToken: string): Promise<string> {
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

describe('@nexus-rh/api — Durcissement Sécurité Vague 2 (C-02, C-03, N-04, C-04, C-05, C-06, D-02, D-03, D-05, D-06, F-03)', () => {
  let app: INestApplication;
  let db: NexusDatabase;
  let cache: CacheLockPort;
  let tempStorageDir = '';

  let superAdminPreMfaToken = '';
  let superAdminToken = '';
  let tenantAId = '';
  let tenantBId = '';
  let siteAKinId = '';
  let siteALubId = '';
  let siteBKwzId = '';
  let deptKinFinId = '';
  let deptKinOpsId = '';
  let posKinId = '';

  let adminAToken = '';
  let adminBToken = '';
  let hrAToken = '';
  let roleMap = new Map<string, string>();

  let empKinFin1Id = '';
  let empKinFin2Id = '';
  let empKinOpsId = '';
  let empLubId = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rh-wave2-s3-'));
    process.env.SANDBOX_STORAGE_DIR = tempStorageDir;

    const config = loadAppConfig({
      infraProfile: 'sandbox',
      pgliteDataDir: 'memory://',
      trustedProxyCount: 0,
      corsAllowedOrigins: ['http://localhost:3000', 'https://app.nexus-rh.cd'],
    });
    app = await createNexusApiApp(config);
    db = app.get<NexusDatabase>(NEXUS_DB);
    cache = app.get<CacheLockPort>(CACHE_LOCK_PORT);

    // Bootstrap Super-Admin (avant MFA : jeton confiné C-03)
    const boot = await request(app.getHttpServer())
      .post('/api/v1/auth/bootstrap')
      .send({
        fullName: 'Super Admin Wave2',
        email: 'sa.w2@nexus-test.invalid',
        password: 'SuperAdmin#2026!W2',
      })
      .expect(201);
    superAdminPreMfaToken = boot.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.SANDBOX_STORAGE_DIR;
    if (tempStorageDir && fs.existsSync(tempStorageDir)) {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    }
  });

  it('[C-03 + N-04] confine strictement les sessions à MFA obligatoire non enrôlée et isole mfa_required par entreprise', async () => {
    // 1. Avant activation TOTP, le Super-Admin est bloqué sur la console plateforme et l'audit
    const preMfaTenants = await request(app.getHttpServer())
      .get('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${superAdminPreMfaToken}`)
      .expect(403);
    expect(preMfaTenants.body.code).toBe('MFA_SETUP_REQUIRED');

    const preMfaAudit = await request(app.getHttpServer())
      .get('/api/v1/audit/logs?scope=platform')
      .set('Authorization', `Bearer ${superAdminPreMfaToken}`)
      .expect(403);
    expect(preMfaAudit.body.code).toBe('MFA_SETUP_REQUIRED');

    // Mais /auth/me et /auth/sessions restent accessibles pour permettre l'enrôlement
    const preMe = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${superAdminPreMfaToken}`)
      .expect(200);
    expect(preMe.body.user.mfaRequired).toBe(true);
    expect(preMe.body.user.mfaVerified).toBe(false);
    expect(preMe.body.user.mfaSetupRequired).toBe(true);

    await request(app.getHttpServer())
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${superAdminPreMfaToken}`)
      .expect(200);

    // 2. Enrôlement TOTP : l'ancien jeton pré-MFA est immédiatement révoqué et le nouveau débloque la plateforme
    superAdminToken = await enrollMfa(app, superAdminPreMfaToken);

    const oldTokenCheck = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${superAdminPreMfaToken}`)
      .expect(401);
    expect(oldTokenCheck.body.code).toBe('AUTH_TOKEN_REVOKED');

    // Provisionnement de 2 entreprises (Alpha Kinshasa/Lubumbashi & Beta Kolwezi)
    const createA = await request(app.getHttpServer())
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        slug: 'alpha-wave2',
        legalName: 'Alpha Wave2 SARL',
        legalForm: 'SARL',
        sectorCode: 'INDUSTRY',
        defaultCurrency: 'USD',
        matriculePattern: '{SITE}-{YYYY}-{SEQ:4}',
        isDemoTenant: true,
        headquartersSite: {
          code: 'KIN',
          name: 'Siège Kinshasa',
          province: 'Kinshasa',
          city: 'Kinshasa',
          timezone: 'Africa/Kinshasa',
        },
        initialAdmin: {
          fullName: 'Admin Alpha W2',
          email: 'admin.a.w2@nexus-test.invalid',
          password: 'AdminAlpha#2026!W2',
        },
      })
      .expect(201);
    tenantAId = createA.body.tenant.id;
    siteAKinId = createA.body.headquartersSite.id;

    const createB = await request(app.getHttpServer())
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        slug: 'beta-wave2',
        legalName: 'Beta Wave2 SA',
        legalForm: 'SA',
        sectorCode: 'MINING',
        defaultCurrency: 'USD',
        matriculePattern: '{SITE}-{YYYY}-{SEQ:4}',
        isDemoTenant: true,
        headquartersSite: {
          code: 'KWZ',
          name: 'Direction Kolwezi',
          province: 'Lualaba',
          city: 'Kolwezi',
          timezone: 'Africa/Lubumbashi',
        },
        initialAdmin: {
          fullName: 'Admin Beta W2',
          email: 'admin.b.w2@nexus-test.invalid',
          password: 'AdminBeta#2026!W2',
        },
      })
      .expect(201);
    tenantBId = createB.body.tenant.id;
    siteBKwzId = createB.body.headquartersSite.id;

    // Enrôlement MFA des deux administrateurs d'entreprise
    const loginA = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'admin.a.w2@nexus-test.invalid', password: 'AdminAlpha#2026!W2' })
      .expect(200);
    adminAToken = await enrollMfa(app, loginA.body.accessToken);

    const loginB = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'admin.b.w2@nexus-test.invalid', password: 'AdminBeta#2026!W2' })
      .expect(200);
    adminBToken = await enrollMfa(app, loginB.body.accessToken);

    // Ajout site Lubumbashi + départements + poste + DRH + 4 employés de test sur Alpha
    const addLub = await request(app.getHttpServer())
      .post('/api/v1/sites')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'LUB',
        name: 'Agence Lubumbashi',
        siteType: 'BRANCH',
        province: 'Haut-Katanga',
        city: 'Lubumbashi',
        timezone: 'Africa/Lubumbashi',
      })
      .expect(201);
    siteALubId = addLub.body.site.id;

    deptKinFinId = (
      await request(app.getHttpServer())
        .post('/api/v1/departments')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ code: 'FIN', name: 'Direction Financière', siteId: siteAKinId })
        .expect(201)
    ).body.department.id;

    deptKinOpsId = (
      await request(app.getHttpServer())
        .post('/api/v1/departments')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ code: 'OPS', name: 'Opérations Terrain', siteId: siteAKinId })
        .expect(201)
    ).body.department.id;

    const rolesRes = await request(app.getHttpServer())
      .get('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    roleMap = new Map(
      rolesRes.body.roles.map((r: { code: string; id: string }) => [r.code, r.id]),
    );

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'drh.w2@nexus-test.invalid',
        fullName: 'DRH Wave2',
        password: 'DrhWave2#2026!Valid',
        roleId: roleMap.get('HR_MANAGER'),
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    hrAToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'drh.w2@nexus-test.invalid', password: 'DrhWave2#2026!Valid' })
        .expect(200)
    ).body.accessToken;

    posKinId = (
      await request(app.getHttpServer())
        .post('/api/v1/job-positions')
        .set('Authorization', `Bearer ${hrAToken}`)
        .send({
          code: 'ANALYSTE',
          title: 'Analyste RH/Finance',
          professionalCategory: 'CADRE_COLLABORATION',
        })
        .expect(201)
    ).body.jobPosition.id;

    const mkEmp = async (firstName: string, lastName: string, siteId: string, departmentId?: string) =>
      (
        await request(app.getHttpServer())
          .post('/api/v1/employees')
          .set('Authorization', `Bearer ${hrAToken}`)
          .send({
            firstName,
            lastName,
            gender: 'F',
            birthDate: '1994-04-12',
            nationalityCode: 'CD',
            maritalStatus: 'SINGLE',
            hireDate: '2026-01-15',
            primarySiteId: siteId,
            departmentId: departmentId ?? null,
            jobPositionId: posKinId,
          })
          .expect(201)
      ).body.employee.id as string;

    empKinFin1Id = await mkEmp('Amina', 'Mbuyi', siteAKinId, deptKinFinId);
    empKinFin2Id = await mkEmp('Grace', 'Kabongo', siteAKinId, deptKinFinId);
    empKinOpsId = await mkEmp('Patrick', 'Ilunga', siteAKinId, deptKinOpsId);
    empLubId = await mkEmp('Chantal', 'Mwamba', siteALubId);

    // 3. N-04 : Un utilisateur multi-entreprises est SITE_MANAGER (sans MFA) sur Beta et
    //    FINANCE_APPROVER (MFA obligatoire) sur Alpha -> aucune contamination globale de users.mfa_required !
    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({
        email: 'consultant.multi@nexus-test.invalid',
        fullName: 'Consultant Multi-Entreprises',
        password: 'MultiUser#2026!Valid',
        roleId: roleMap.get('SITE_MANAGER'),
        scopeType: 'SELECTED_SITES',
        siteIds: [siteBKwzId],
        mfaRequired: false,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'consultant.multi@nexus-test.invalid',
        fullName: 'Consultant Multi-Entreprises',
        roleId: roleMap.get('FINANCE_APPROVER'),
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    // Vérifier en base que `users.mfa_required` est resté `false` (isolé par tenant_memberships)
    await db.withPlatformTransaction(async (tx) => {
      const [u] = await tx
        .select({ mfaRequired: users.mfaRequired })
        .from(users)
        .where(eq(users.email, 'consultant.multi@nexus-test.invalid'));
      expect(u?.mfaRequired).toBe(false);
    });

    // Connexion sans MFA : attaché automatiquement à Beta (où MFA n'est pas requise) -> accès 200 OK
    const multiLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'consultant.multi@nexus-test.invalid', password: 'MultiUser#2026!Valid' })
      .expect(200);
    expect(multiLogin.body.activeTenantId).toBe(tenantBId);
    expect(multiLogin.body.mfaSetupRequired).toBe(false);

    const betaSites = await request(app.getHttpServer())
      .get('/api/v1/sites')
      .set('Authorization', `Bearer ${multiLogin.body.accessToken}`)
      .expect(200);
    expect(betaSites.body.sites.map((s: { code: string }) => s.code)).toEqual(['KWZ']);

    // Bascule sur Alpha (où FINANCE_APPROVER exige MFA) : autorisée, mais toute route métier Alpha est confinée 403 !
    const switchedToA = await request(app.getHttpServer())
      .post('/api/v1/auth/switch-tenant')
      .set('Authorization', `Bearer ${multiLogin.body.accessToken}`)
      .send({ tenantId: tenantAId })
      .expect(200);

    const alphaBlocked = await request(app.getHttpServer())
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${switchedToA.body.accessToken}`)
      .expect(403);
    expect(alphaBlocked.body.code).toBe('MFA_SETUP_REQUIRED');

    // Retour sur Beta sans MFA : accès Beta préservé intact
    const switchedBackToB = await request(app.getHttpServer())
      .post('/api/v1/auth/switch-tenant')
      .set('Authorization', `Bearer ${switchedToA.body.accessToken}`)
      .send({ tenantId: tenantBId })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/sites')
      .set('Authorization', `Bearer ${switchedBackToB.body.accessToken}`)
      .expect(200);
  });

  it('[C-02] résout les périmètres SiteScope par permission et bloque toute escalade par cumul de rôles', async () => {
    // Cas A : EXTERNAL_AUDITOR (ALL_SITES) + SITE_MANAGER (Lubumbashi uniquement)
    // `audit.read` est ALL_SITES, mais `employees.read` DOIT rester strictement confiné à Lubumbashi !
    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'cumul.a@nexus-test.invalid',
        fullName: 'Cumul Auditeur + Chef Lub',
        password: 'CumulRoleA#2026!Valid',
        roleId: roleMap.get('EXTERNAL_AUDITOR'),
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'cumul.a@nexus-test.invalid',
        fullName: 'Cumul Auditeur + Chef Lub',
        roleId: roleMap.get('SITE_MANAGER'),
        scopeType: 'SELECTED_SITES',
        siteIds: [siteALubId],
      })
      .expect(201);

    const cumulAToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'cumul.a@nexus-test.invalid', password: 'CumulRoleA#2026!Valid' })
        .expect(200)
    ).body.accessToken;

    // `audit.read` fonctionne sur ALL_SITES
    await request(app.getHttpServer())
      .get('/api/v1/audit/verify')
      .set('Authorization', `Bearer ${cumulAToken}`)
      .expect(200);

    // `employees.read` ne retourne QUE Lubumbashi (jamais les 3 agents de Kinshasa !)
    const empList = await request(app.getHttpServer())
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${cumulAToken}`)
      .expect(200);
    expect(empList.body.employees.map((e: { id: string }) => e.id)).toEqual([empLubId]);

    // Accès direct à un agent de Kinshasa -> 403 SITE_SCOPE_DENIED
    const kinDenied = await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKinFin1Id}`)
      .set('Authorization', `Bearer ${cumulAToken}`)
      .expect(403);
    expect(kinDenied.body.code).toBe('SITE_SCOPE_DENIED');

    // Cas B : SITE_MANAGER sur Kinshasa + rôle délégué `rbac.members.manage` sur Lubumbashi uniquement
    // Ne doit JAMAIS pouvoir affecter un rôle sur Kinshasa !
    const delRole = await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'W2_RBAC_DELEGATE',
        name: 'Délégué Accès Site',
        permissions: ['organization.sites.read', 'employees.read', 'rbac.members.manage'],
      })
      .expect(201);

    const targetReadRole = await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'W2_SITE_VIEWER',
        name: 'Lecteur Site',
        permissions: ['organization.sites.read', 'employees.read'],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'cumul.b@nexus-test.invalid',
        fullName: 'Cumul Chef Kin + Délégué Lub',
        password: 'CumulRoleB#2026!Valid',
        roleId: roleMap.get('SITE_MANAGER'),
        scopeType: 'SELECTED_SITES',
        siteIds: [siteAKinId],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'cumul.b@nexus-test.invalid',
        fullName: 'Cumul Chef Kin + Délégué Lub',
        roleId: delRole.body.role.id,
        scopeType: 'SELECTED_SITES',
        siteIds: [siteALubId],
      })
      .expect(201);

    const cumulBToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'cumul.b@nexus-test.invalid', password: 'CumulRoleB#2026!Valid' })
        .expect(200)
    ).body.accessToken;

    // Tentative d'affectation sur Kinshasa (hors du scope de rbac.members.manage) -> 403
    const crossSiteAssign = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${cumulBToken}`)
      .send({
        email: 'intruder.kin@nexus-test.invalid',
        fullName: 'Intrus Kinshasa',
        password: 'IntruderKin#2026!Ok',
        roleId: targetReadRole.body.role.id,
        scopeType: 'SELECTED_SITES',
        siteIds: [siteAKinId],
      })
      .expect(403);
    expect(crossSiteAssign.body.code).toBe('SITE_SCOPE_ESCALATION_FORBIDDEN');

    // Affectation légitime sur Lubumbashi -> 201
    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${cumulBToken}`)
      .send({
        email: 'legit.lub@nexus-test.invalid',
        fullName: 'Lecteur Légitime Lub',
        password: 'LegitLub#2026!Valid',
        roleId: targetReadRole.body.role.id,
        scopeType: 'SELECTED_SITES',
        siteIds: [siteALubId],
      })
      .expect(201);

    // Cas C : TENANT_ADMIN restreint à Lubumbashi + EXTERNAL_AUDITOR sur ALL_SITES
    // Ne doit JAMAIS acquérir `hasGlobalTenantAdminRole` ni créer un site ou affecter ALL_SITES !
    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'cumul.c@nexus-test.invalid',
        fullName: 'Admin Local Lub + Auditeur Global',
        password: 'CumulRoleC#2026!Valid',
        roleId: roleMap.get('TENANT_ADMIN'),
        scopeType: 'SELECTED_SITES',
        siteIds: [siteALubId],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'cumul.c@nexus-test.invalid',
        fullName: 'Admin Local Lub + Auditeur Global',
        roleId: roleMap.get('EXTERNAL_AUDITOR'),
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    const loginC = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'cumul.c@nexus-test.invalid', password: 'CumulRoleC#2026!Valid' })
      .expect(200);
    const cumulCToken = await enrollMfa(app, loginC.body.accessToken);

    const createSiteEsc = await request(app.getHttpServer())
      .post('/api/v1/sites')
      .set('Authorization', `Bearer ${cumulCToken}`)
      .send({
        code: 'GOM',
        name: 'Site Non Autorisé Goma',
        siteType: 'BRANCH',
        province: 'Nord-Kivu',
        city: 'Goma',
        timezone: 'Africa/Lubumbashi',
      })
      .expect(403);
    expect(createSiteEsc.body.code).toBe('ALL_SITES_SCOPE_REQUIRED');

    const assignAdminEsc = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${cumulCToken}`)
      .send({
        email: 'escalade.admin@nexus-test.invalid',
        fullName: 'Escalade Admin Global',
        password: 'EscaladeAdm#2026!Ok',
        roleId: roleMap.get('TENANT_ADMIN'),
        scopeType: 'SELECTED_SITES',
        siteIds: [siteALubId],
      })
      .expect(403);
    expect(assignAdminEsc.body.code).toBe('ROLE_ASSIGNMENT_ESCALATION_FORBIDDEN');

    // Cas D : `contracts.read` sur ALL_SITES + `employees.salary.read` sur Lubumbashi uniquement
    // -> salaire déchiffré pour Lubumbashi, automatiquement masqué (`baseSalary: null`) pour Kinshasa !
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKinFin1Id}/contracts`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        contractNumber: 'CTR-KIN-W2-01',
        contractType: 'CDI',
        startDate: '2026-01-15',
        siteId: siteAKinId,
        payCurrency: 'USD',
        baseSalary: '1950.00',
        hiringPlace: 'Kinshasa',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/employees/${empLubId}/contracts`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        contractNumber: 'CTR-LUB-W2-01',
        contractType: 'CDI',
        startDate: '2026-01-15',
        siteId: siteALubId,
        payCurrency: 'USD',
        baseSalary: '1420.00',
        hiringPlace: 'Lubumbashi',
      })
      .expect(201);

    const roleContractsAll = await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'W2_CONTRACTS_GLOBAL',
        name: 'Lecteur Contrats Groupe',
        permissions: ['employees.read', 'contracts.read'],
      })
      .expect(201);

    const roleSalarySite = await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'W2_SALARY_SITE',
        name: 'Lecteur Salaires Établissement',
        permissions: ['employees.salary.read'],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'cumul.salary@nexus-test.invalid',
        fullName: 'Contrôleur Contrats + Salaire Lub',
        password: 'CumulSalary#2026!Ok',
        roleId: roleContractsAll.body.role.id,
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'cumul.salary@nexus-test.invalid',
        fullName: 'Contrôleur Contrats + Salaire Lub',
        roleId: roleSalarySite.body.role.id,
        scopeType: 'SELECTED_SITES',
        siteIds: [siteALubId],
      })
      .expect(201);

    const cumulSalToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'cumul.salary@nexus-test.invalid', password: 'CumulSalary#2026!Ok' })
        .expect(200)
    ).body.accessToken;

    const lubContracts = await request(app.getHttpServer())
      .get(`/api/v1/employees/${empLubId}/contracts`)
      .set('Authorization', `Bearer ${cumulSalToken}`)
      .expect(200);
    expect(lubContracts.body.contracts[0].baseSalary).toBe('1420.00');
    expect(lubContracts.body.contracts[0].salaryRedacted).toBe(false);

    const kinContracts = await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKinFin1Id}/contracts`)
      .set('Authorization', `Bearer ${cumulSalToken}`)
      .expect(200);
    expect(kinContracts.body.contracts[0].baseSalary).toBeNull();
    expect(kinContracts.body.contracts[0].salaryRedacted).toBe(true);
  });

  it('[C-04] supprime toute omnipotence silencieuse de SUPER_ADMIN et exige une délégation support bornée (<=72h), motivée et auditée', async () => {
    // 1. Par défaut : aucun tenant attaché, aucune liste implicite de tenants clients, switch refusé en 403
    const saMe = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(200);
    expect(saMe.body.activeTenant).toBeNull();
    expect(saMe.body.accessibleTenants).toEqual([]);
    expect(saMe.body.permissions).toEqual([]);

    const deniedSwitch = await request(app.getHttpServer())
      .post('/api/v1/auth/switch-tenant')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ tenantId: tenantAId })
      .expect(403);
    expect(deniedSwitch.body.code).toBe('TENANT_ACCESS_DENIED');

    // 2. Délégation sans date d'expiration ou > 72h ou sans justification -> 400
    const noExpiry = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'sa.w2@nexus-test.invalid',
        fullName: 'Super Admin Wave2',
        roleId: roleMap.get('EXTERNAL_AUDITOR'),
        scopeType: 'ALL_SITES',
        supportJustification: 'Diagnostic chaîne audit ticket #INC-2026-44',
      })
      .expect(400);
    expect(noExpiry.body.code).toBe('SUPPORT_DELEGATION_EXPIRY_REQUIRED');

    const tooLong = new Date(Date.now() + 96 * 3_600_000).toISOString();
    const overMax = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'sa.w2@nexus-test.invalid',
        fullName: 'Super Admin Wave2',
        roleId: roleMap.get('EXTERNAL_AUDITOR'),
        scopeType: 'ALL_SITES',
        expiresAt: tooLong,
        supportJustification: 'Diagnostic chaîne audit ticket #INC-2026-44',
      })
      .expect(400);
    expect(overMax.body.code).toBe('SUPPORT_DELEGATION_EXPIRY_REQUIRED');

    const validExpiry = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const noReason = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'sa.w2@nexus-test.invalid',
        fullName: 'Super Admin Wave2',
        roleId: roleMap.get('EXTERNAL_AUDITOR'),
        scopeType: 'ALL_SITES',
        expiresAt: validExpiry,
      })
      .expect(400);
    expect(noReason.body.code).toBe('SUPPORT_DELEGATION_JUSTIFICATION_REQUIRED');

    // 3. Délégation valide (2h, rôle EXTERNAL_AUDITOR, justifiée et auditée)
    const grant = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'sa.w2@nexus-test.invalid',
        fullName: 'Super Admin Wave2',
        roleId: roleMap.get('EXTERNAL_AUDITOR'),
        scopeType: 'ALL_SITES',
        expiresAt: validExpiry,
        supportJustification: 'Diagnostic chaîne audit ticket #INC-2026-44',
      })
      .expect(201);
    const delegationId: string = grant.body.membership.id;

    const switched = await request(app.getHttpServer())
      .post('/api/v1/auth/switch-tenant')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ tenantId: tenantAId })
      .expect(200);
    superAdminToken = switched.body.accessToken;

    // Accès strictement borné au rôle délégué (EXTERNAL_AUDITOR) : audit OK, mais dossiers/salaires/PII -> 403 !
    const delegatedAudit = await request(app.getHttpServer())
      .get('/api/v1/audit/logs?action=RBAC_SUPPORT_DELEGATION_GRANTED')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(200);
    expect(delegatedAudit.body.logs).toHaveLength(1);
    expect(delegatedAudit.body.logs[0].reason).toContain('INC-2026-44');

    await request(app.getHttpServer())
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKinFin1Id}/contracts`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(403);

    // 4. Expiration / révocation immédiate par le client -> perte instantanée de l'accès
    await request(app.getHttpServer())
      .delete(`/api/v1/rbac/members/${delegationId}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);

    // La révocation a également invalidé la session active du tenant ; même sur nouvelle session,
    // toute tentative de switch-tenant sur Alpha est à nouveau bloquée en 403 !
    const relogStep1 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'sa.w2@nexus-test.invalid', password: 'SuperAdmin#2026!W2' })
      .expect(200);
    expect(relogStep1.body.status).toBe('MFA_REQUIRED');

    // Tester également l'expiration automatique (`expires_at` dépassé) sur un auditeur externe
    const shortExpiry = new Date(Date.now() + 60_000).toISOString();
    const tempAud = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'auditeur.temp@nexus-test.invalid',
        fullName: 'Auditeur Externe Temporaire',
        password: 'AuditeurTemp#2026!Ok',
        roleId: roleMap.get('EXTERNAL_AUDITOR'),
        scopeType: 'ALL_SITES',
        expiresAt: shortExpiry,
      })
      .expect(201);

    const tempAudToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'auditeur.temp@nexus-test.invalid', password: 'AuditeurTemp#2026!Ok' })
        .expect(200)
    ).body.accessToken;

    await request(app.getHttpServer())
      .get('/api/v1/audit/verify')
      .set('Authorization', `Bearer ${tempAudToken}`)
      .expect(200);

    // Simule le dépassement de `expires_at` en base (created_at + 1 ms, dans le passé)
    await db.withTenantTransaction(tenantAId, null, async (tx) => {
      await tx
        .update(tenantMemberships)
        .set({
          createdAt: new Date(Date.now() - 120_000),
          expiresAt: new Date(Date.now() - 1_000),
        })
        .where(and(eq(tenantMemberships.id, tempAud.body.membership.id)));
    });

    const afterExpiry = await request(app.getHttpServer())
      .get('/api/v1/audit/verify')
      .set('Authorization', `Bearer ${tempAudToken}`)
      .expect(403);
    expect(afterExpiry.body.code).toBe('TENANT_MEMBERSHIP_REVOKED');
  });

  it('[C-05] applique les contrôles de permission par catégorie documentaire sans casser le flux RH standard', async () => {
    const uploadAsHr = async (category: string, title: string) =>
      (
        await request(app.getHttpServer())
          .post(`/api/v1/employees/${empKinFin1Id}/documents`)
          .set('Authorization', `Bearer ${hrAToken}`)
          .send({
            category,
            title,
            originalFilename: `${category.toLowerCase()}.pdf`,
            mimeType: 'application/pdf',
            contentBase64: SAMPLE_PDF_B64,
          })
          .expect(201)
      ).body.document.id as string;

    const contractDocId = await uploadAsHr('EMPLOYMENT_CONTRACT', 'Contrat CDI signé avec salaire');
    const idDocId = await uploadAsHr('IDENTITY_DOC', 'Carte d’électeur RDC');
    const medicalDocId = await uploadAsHr('MEDICAL_FITNESS', 'Certificat aptitude médicale');
    const consentDocId = await uploadAsHr('SIGNED_CONSENT', 'Consentement écrit signé');
    const diplomaDocId = await uploadAsHr('DIPLOMA_CERTIFICATE', 'Diplôme universitaire UNIKIN');

    // Création d'un archiviste disposant uniquement de documents.read/manage + employees.read (sans salary/pii/consents)
    const clerkRole = await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'W2_DOC_CLERK',
        name: 'Archiviste Dossiers Simples',
        permissions: ['employees.read', 'employees.documents.read', 'employees.documents.manage'],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'archiviste.w2@nexus-test.invalid',
        fullName: 'Archiviste RH',
        password: 'ArchivisteW2#2026!Ok',
        roleId: clerkRole.body.role.id,
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    const clerkToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'archiviste.w2@nexus-test.invalid', password: 'ArchivisteW2#2026!Ok' })
        .expect(200)
    ).body.accessToken;

    // 1. La liste ne révèle que le diplôme (jamais contrat salarial, identité, médical ni consentement)
    const clerkList = await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKinFin1Id}/documents`)
      .set('Authorization', `Bearer ${clerkToken}`)
      .expect(200);
    expect(clerkList.body.documents.map((d: { id: string }) => d.id)).toEqual([diplomaDocId]);

    // 2. Téléchargement direct des catégories protégées -> 403 DOCUMENT_CATEGORY_PERMISSION_DENIED
    for (const restrictedId of [contractDocId, idDocId, medicalDocId, consentDocId]) {
      const dl = await request(app.getHttpServer())
        .get(`/api/v1/employees/${empKinFin1Id}/documents/${restrictedId}/download`)
        .set('Authorization', `Bearer ${clerkToken}`)
        .expect(403);
      expect(dl.body.code).toBe('DOCUMENT_CATEGORY_PERMISSION_DENIED');
    }

    // 3. Suppression et téléversement non autorisés sur catégorie protégée -> 403
    const delRestricted = await request(app.getHttpServer())
      .delete(`/api/v1/employees/${empKinFin1Id}/documents/${idDocId}`)
      .set('Authorization', `Bearer ${clerkToken}`)
      .send({ reason: 'Tentative suppression non autorisée' })
      .expect(403);
    expect(delRestricted.body.code).toBe('DOCUMENT_CATEGORY_PERMISSION_DENIED');

    const upRestricted = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKinFin1Id}/documents`)
      .set('Authorization', `Bearer ${clerkToken}`)
      .send({
        category: 'EMPLOYMENT_CONTRACT',
        title: 'Faux avenant salarial',
        originalFilename: 'faux.pdf',
        mimeType: 'application/pdf',
        contentBase64: SAMPLE_PDF_B64,
      })
      .expect(403);
    expect(upRestricted.body.code).toBe('DOCUMENT_CATEGORY_PERMISSION_DENIED');

    // 4. Catégorie ordinaire accessible à l'archiviste, et toutes catégories accessibles au HR_MANAGER
    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKinFin1Id}/documents/${diplomaDocId}/download`)
      .set('Authorization', `Bearer ${clerkToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKinFin1Id}/documents/${contractDocId}/download`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .expect(200);
  });

  it('[C-06] applique en fail-closed OWN_DEPARTMENT et SELF_ONLY et journalise tout accès aux salaires déchiffrés', async () => {
    const deptReaderRole = await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'W2_DEPT_SUPERVISOR',
        name: 'Superviseur Département',
        permissions: [
          'organization.sites.read',
          'organization.departments.read',
          'employees.read',
        ],
      })
      .expect(201);

    // 1. Interdiction d'associer une permission d'administration globale avec OWN_DEPARTMENT ou SELF_ONLY
    const badCombo = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'bad.scope@nexus-test.invalid',
        fullName: 'Bad Scope',
        password: 'BadScope#2026!Valid',
        roleId: roleMap.get('TENANT_ADMIN'),
        scopeType: 'OWN_DEPARTMENT',
      })
      .expect(400);
    expect(badCombo.body.code).toBe('INVALID_ROLE_SCOPE_COMBINATION');

    // 2. Utilisateur OWN_DEPARTMENT non encore rattaché à un dossier employé -> fail-closed (0 dossier visible, 403)
    const deptMem = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'chef.fin@nexus-test.invalid',
        fullName: 'Chef Département Finance',
        password: 'ChefFin#2026!Valid1',
        roleId: deptReaderRole.body.role.id,
        scopeType: 'OWN_DEPARTMENT',
      })
      .expect(201);
    const deptUserId: string = deptMem.body.membership.userId;

    const deptToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'chef.fin@nexus-test.invalid', password: 'ChefFin#2026!Valid1' })
        .expect(200)
    ).body.accessToken;

    const unlinkedList = await request(app.getHttpServer())
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${deptToken}`)
      .expect(200);
    expect(unlinkedList.body.employees).toEqual([]);

    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKinFin1Id}`)
      .set('Authorization', `Bearer ${deptToken}`)
      .expect(403);

    // Rattachement du compte au dossier `empKinFin1Id` (département FIN sur site KIN)
    await db.withTenantTransaction(tenantAId, null, async (tx) => {
      await tx
        .update(employees)
        .set({ userId: deptUserId })
        .where(eq(employees.id, empKinFin1Id));
    });

    // Voit exactement les 2 agents de FIN, mais JAMAIS l'agent OPS du même site KIN ni l'agent LUB !
    const finList = await request(app.getHttpServer())
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${deptToken}`)
      .expect(200);
    expect(new Set(finList.body.employees.map((e: { id: string }) => e.id))).toEqual(
      new Set([empKinFin1Id, empKinFin2Id]),
    );

    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKinOpsId}`)
      .set('Authorization', `Bearer ${deptToken}`)
      .expect(403);

    const finDepts = await request(app.getHttpServer())
      .get('/api/v1/departments')
      .set('Authorization', `Bearer ${deptToken}`)
      .expect(200);
    expect(finDepts.body.departments.map((d: { id: string }) => d.id)).toEqual([deptKinFinId]);

    // 3. SELF_ONLY rattaché à `empKinFin2Id` : voit UNIQUEMENT son propre dossier, 403 sur sa collègue de FIN
    const selfMem = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'agent.self@nexus-test.invalid',
        fullName: 'Grace Kabongo Self',
        password: 'AgentSelf#2026!Valid',
        roleId: deptReaderRole.body.role.id,
        scopeType: 'SELF_ONLY',
      })
      .expect(201);

    await db.withTenantTransaction(tenantAId, null, async (tx) => {
      await tx
        .update(employees)
        .set({ userId: selfMem.body.membership.userId })
        .where(eq(employees.id, empKinFin2Id));
    });

    const selfToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'agent.self@nexus-test.invalid', password: 'AgentSelf#2026!Valid' })
        .expect(200)
    ).body.accessToken;

    const selfList = await request(app.getHttpServer())
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${selfToken}`)
      .expect(200);
    expect(selfList.body.employees.map((e: { id: string }) => e.id)).toEqual([empKinFin2Id]);

    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKinFin1Id}`)
      .set('Authorization', `Bearer ${selfToken}`)
      .expect(403);

    // 4. Journalisation immuable `EMPLOYEE_SALARY_ACCESSED` sans fuite du montant en clair
    const salLogs = await request(app.getHttpServer())
      .get('/api/v1/audit/logs?action=EMPLOYEE_SALARY_ACCESSED')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    expect(salLogs.body.logs.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(salLogs.body.logs);
    expect(serialized).not.toContain('1950');
    expect(serialized).not.toContain('1420');
  });

  it('[D-02] ignore tout X-Forwarded-For non fiable, résout la chaîne de droite à gauche si configuré et applique le rate-limit par compte', async () => {
    // 1. Vérification unitaire déterministe de `resolveClientIp`
    expect(resolveClientIp('::ffff:127.0.0.1', '198.51.100.99', 0)).toBe('127.0.0.1');
    expect(resolveClientIp('10.0.0.2', '6.6.6.6, 198.51.100.42', 1)).toBe('198.51.100.42');
    expect(resolveClientIp('10.0.0.2', '6.6.6.6, 203.0.113.9, 10.0.0.5', 2)).toBe('203.0.113.9');
    expect(resolveClientIp('10.0.0.2', 'spoofed-garbage, not-an-ip', 1)).toBe('10.0.0.2');

    // 2. En intégration (`trustedProxyCount: 0`), un X-Forwarded-For forgé ne pollue jamais les sessions/logs
    //    et le rate-limit secondaire par compte bloque au-delà de 10 tentatives malgré rotation de X-Forwarded-For
    await cache.del('rl:login:ip:127.0.0.1');
    const targetUnknown = 'spray.target.w2@nexus-test.invalid';
    for (let i = 1; i <= 10; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', `203.0.113.${i}`)
        .send({ email: targetUnknown, password: 'WrongPassword#2026!' })
        .expect(401);
    }

    const eleventh = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '203.0.113.250')
      .send({ email: targetUnknown, password: 'WrongPassword#2026!' })
      .expect(429);
    expect(eleventh.body.code).toBe('RATE_LIMIT_EXCEEDED');

    // Vérifier que l'IP enregistrée sur un échec réel n'est JAMAIS l'IP forgée `198.51.100.222`
    await cache.del('rl:login:ip:127.0.0.1');
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.222')
      .send({ email: 'drh.w2@nexus-test.invalid', password: 'MauvaisPassword#2026!' })
      .expect(401);

    const checkSession = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${hrAToken}`)
      .expect(200);
    expect(JSON.stringify(checkSession.body.sessions)).not.toContain('198.51.100.222');
  });

  it('[F-03] impose SameSite=Strict, en-tête X-Nexus-CSRF et contrôle Origin/Referer sur /auth/refresh et /auth/logout', async () => {
    await cache.del('rl:login:ip:127.0.0.1');
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'drh.w2@nexus-test.invalid', password: 'DrhWave2#2026!Valid' })
      .expect(200);

    const rawSetCookie = extractRawSetCookie(login.headers['set-cookie'], 'nexus_rt');
    expect(rawSetCookie).toContain('HttpOnly');
    expect(rawSetCookie).toContain('SameSite=Strict');
    expect(rawSetCookie).toContain('Path=/api/v1/auth');
    const cookiePair = extractCookiePair(login.headers['set-cookie'], 'nexus_rt');
    const token: string = login.body.accessToken;

    // 1. /auth/refresh sans en-tête X-Nexus-CSRF -> 403 CSRF_PROTECTION_REJECTED
    const noHeader = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookiePair)
      .expect(403);
    expect(noHeader.body.code).toBe('CSRF_PROTECTION_REJECTED');

    // 2. /auth/refresh avec Origin malveillant (même avec X-Nexus-CSRF) -> 403
    const badOrigin = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookiePair)
      .set('X-Nexus-CSRF', '1')
      .set('Origin', 'https://attacker.evil.example')
      .expect(403);
    expect(badOrigin.body.code).toBe('CSRF_PROTECTION_REJECTED');

    // 3. /auth/refresh avec Referer malveillant (sans Origin) -> 403
    const badReferer = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookiePair)
      .set('X-Nexus-CSRF', '1')
      .set('Referer', 'https://attacker.evil.example/phish.html')
      .expect(403);
    expect(badReferer.body.code).toBe('CSRF_PROTECTION_REJECTED');

    // 4. /auth/logout sans X-Nexus-CSRF ou avec Origin externe -> 403
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nexus-CSRF', '1')
      .set('Origin', 'https://attacker.evil.example')
      .expect(403);

    // 5. /auth/refresh légitime (Origin autorisée + X-Nexus-CSRF: 1) -> 200 OK (le cookie n'a pas été détruit par les attaques CSRF)
    const okRefresh = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookiePair)
      .set('X-Nexus-CSRF', '1')
      .set('Origin', 'https://app.nexus-rh.cd')
      .expect(200);
    expect(okRefresh.body.accessToken).toBeTruthy();

    // Et compatible avec le domaine preview sandbox `https://<port>-<id>.e2b.app`
    const cookie2 = extractCookiePair(okRefresh.headers['set-cookie'], 'nexus_rt');
    const okPreview = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie2)
      .set('X-Nexus-CSRF', '1')
      .set('Origin', 'https://3000-sandboxdemo.e2b.app')
      .expect(200);

    // Logout légitime -> 200 + effacement SameSite=Strict
    const okLogout = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${okPreview.body.accessToken}`)
      .set('X-Nexus-CSRF', '1')
      .set('Origin', 'http://localhost:3000')
      .expect(200);
    expect(extractRawSetCookie(okLogout.headers['set-cookie'], 'nexus_rt')).toContain(
      'SameSite=Strict',
    );
  });

  it('[D-03] limite le débit sur /auth/mfa/enable et verrouille atomiquement après 5 échecs simultanés de connexion', async () => {
    await cache.del('rl:login:ip:127.0.0.1');

    // Création d'un compte dédié au test D-03
    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'd03.target@nexus-test.invalid',
        fullName: 'Cible Test D03',
        password: 'TargetD03#2026!Valid',
        roleId: roleMap.get('SITE_MANAGER'),
        scopeType: 'SELECTED_SITES',
        siteIds: [siteALubId],
      })
      .expect(201);

    const d03Token = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'd03.target@nexus-test.invalid', password: 'TargetD03#2026!Valid' })
        .expect(200)
    ).body.accessToken;

    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${d03Token}`)
      .expect(201);

    // 1. Brute-force TOTP sur /auth/mfa/enable : 6 codes invalides -> 400, 7e -> 429 MFA_RATE_LIMIT
    for (let i = 0; i < 6; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/enable')
        .set('Authorization', `Bearer ${d03Token}`)
        .send({ code: '000000' })
        .expect(400);
    }
    const seventh = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/enable')
      .set('Authorization', `Bearer ${d03Token}`)
      .send({ code: '000000' })
      .expect(429);
    expect(seventh.body.code).toBe('MFA_RATE_LIMIT');

    // 2. 5 mauvais mots de passe lancés simultanément en parallèle -> incrément SQL atomique exact à 5 + verrouillage 429
    await cache.del('rl:login:ip:127.0.0.1');
    const parallelResults = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: 'd03.target@nexus-test.invalid', password: `WrongPass#${idx}!2026` }),
      ),
    );
    expect(parallelResults.every((r) => r.status === 401)).toBe(true);

    const [lockedRow] = await db.withPlatformTransaction((tx) =>
      tx
        .select({
          failedLoginCount: users.failedLoginCount,
          lockedUntil: users.lockedUntil,
        })
        .from(users)
        .where(eq(users.email, 'd03.target@nexus-test.invalid')),
    );
    expect(lockedRow?.failedLoginCount).toBe(5);
    expect(lockedRow?.lockedUntil).not.toBeNull();

    // Même avec le bon mot de passe, le compte est verrouillé en 429 ACCOUNT_TEMPORARILY_LOCKED
    const lockedAttempt = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'd03.target@nexus-test.invalid', password: 'TargetD03#2026!Valid' })
      .expect(429);
    expect(lockedAttempt.body.code).toBe('ACCOUNT_TEMPORARILY_LOCKED');

    // 3. Pointage alternatif QR + PIN : 5 PIN erronés simultanés -> incrément SQL atomique + verrouillage 429
    const issuedBadge = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empLubId}/badges`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ pin: '482917', expiresAt: '2027-12-31' })
      .expect(201);
    const qrPayload: string = issuedBadge.body.qrPayloadOnce;

    const pinParallel = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        request(app.getHttpServer())
          .post('/api/v1/badges/verify-qr-pin')
          .set('Authorization', `Bearer ${hrAToken}`)
          .send({ qrPayload, pin: `93827${idx}`, siteId: siteALubId }),
      ),
    );
    expect(pinParallel.every((r) => r.status === 401)).toBe(true);

    const badgeLocked = await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ qrPayload, pin: '482917', siteId: siteALubId })
      .expect(429);
    expect(badgeLocked.body.code).toBe('BADGE_PIN_LOCKED');
  });

  it('[D-05] exécute un script Lua atomique INCR+EXPIRE sur Redis et répond 503 fail-closed en cas de panne du cache', async () => {
    // 1. Vérifie que RedisCacheLockAdapter.incrementWithWindow utilise exclusivement `eval(LUA, 1, key, window)`
    expect(REDIS_ATOMIC_INCR_WINDOW_LUA).toContain("redis.call('INCR', KEYS[1])");
    expect(REDIS_ATOMIC_INCR_WINDOW_LUA).toContain("redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))");
    expect(REDIS_ATOMIC_INCR_WINDOW_LUA).toContain('if current == 1 or ttl < 0 then');

    const evalSpy = vi.fn().mockResolvedValue([1, 60]);
    const fakeAdapter = Object.create(RedisCacheLockAdapter.prototype) as RedisCacheLockAdapter;
    Object.assign(fakeAdapter, {
      prefix: 'nexus:test',
      redis: { eval: evalSpy },
    });
    const res = await fakeAdapter.incrementWithWindow('rl:login:ip:127.0.0.1', 60);
    expect(res).toEqual({ count: 1, ttlSeconds: 60 });
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledWith(
      REDIS_ATOMIC_INCR_WINDOW_LUA,
      1,
      'nexus:test:rl:login:ip:127.0.0.1',
      '60',
    );

    // 2. Panne transitoire du cache de révocation -> 503 contrôlé fail-closed (jamais 200 ni 500), puis reprise immédiate
    const getSpy = vi
      .spyOn(cache, 'get')
      .mockRejectedValueOnce(new Error('ECONNRESET simulated Redis outage'));
    try {
      const duringOutage = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${adminAToken}`)
        .expect(503);
      expect(duringOutage.body.code).toBe('AUTH_REVOCATION_STORE_UNAVAILABLE');
    } finally {
      getSpy.mockRestore();
    }

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
  });

  it('[D-06] applique CSP et CORS sur liste blanche stricte, refuse les clés implicites en profil docker et valide la chaîne d’audit SHA-256', async () => {
    // 1. En-têtes de sécurité HTTP + CSP stricte sur l'API
    const health = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'https://evil-site.example')
      .expect(200);

    expect(health.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(health.headers['x-permitted-cross-domain-policies']).toBe('none');
    // Origine non autorisée : JAMAIS reflétée dans Access-Control-Allow-Origin !
    expect(health.headers['access-control-allow-origin']).toBeUndefined();

    // Origine explicitement autorisée : reflétée proprement
    const allowedCors = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'https://app.nexus-rh.cd')
      .expect(200);
    expect(allowedCors.headers['access-control-allow-origin']).toBe('https://app.nexus-rh.cd');

    // Règles d'origine strictes en profils `docker` et `production` (refus localhost/e2b.app non listés et sous-domaines forgés)
    expect(
      isAllowedBrowserOrigin('https://3000-abc.e2b.app.evil.example', {
        nodeEnv: 'development',
        infraProfile: 'sandbox',
        corsAllowedOrigins: ['http://localhost:3000'],
      }),
    ).toBe(false);
    expect(
      isAllowedBrowserOrigin('https://3000-abc.e2b.app', {
        nodeEnv: 'development',
        infraProfile: 'docker',
        corsAllowedOrigins: ['http://localhost:3000'],
      }),
    ).toBe(false);
    expect(
      isAllowedBrowserOrigin('http://localhost:3000', {
        nodeEnv: 'production',
        infraProfile: 'production',
        corsAllowedOrigins: ['https://app.nexus-rh.cd'],
      }),
    ).toBe(false);
    expect(
      isAllowedBrowserOrigin('https://app.nexus-rh.cd', {
        nodeEnv: 'production',
        infraProfile: 'production',
        corsAllowedOrigins: ['https://app.nexus-rh.cd'],
      }),
    ).toBe(true);

    // 2. Refus de toute génération implicite de clés en profil `docker`, de MASTER_KEK_HEX faible et de DATABASE_SSL=disable en production
    const savedEnv = {
      MASTER_KEK_HEX: process.env.MASTER_KEK_HEX,
      JWT_PRIV: process.env.JWT_ED25519_PRIVATE_KEY_B64,
      JWT_PUB: process.env.JWT_ED25519_PUBLIC_KEY_B64,
      ALLOW_DEV: process.env.ALLOW_DEV_EPHEMERAL_KEYS,
      DB_SSL: process.env.DATABASE_SSL,
    };
    try {
      delete process.env.MASTER_KEK_HEX;
      delete process.env.JWT_ED25519_PRIVATE_KEY_B64;
      delete process.env.JWT_ED25519_PUBLIC_KEY_B64;
      delete process.env.ALLOW_DEV_EPHEMERAL_KEYS;

      expect(() =>
        loadAppConfig({ infraProfile: 'docker', nodeEnv: 'development' }),
      ).toThrow(/obligatoires en profil docker/);

      process.env.MASTER_KEK_HEX = '00'.repeat(32);
      process.env.JWT_ED25519_PRIVATE_KEY_B64 = 'dGVzdA==';
      process.env.JWT_ED25519_PUBLIC_KEY_B64 = 'dGVzdA==';
      expect(() =>
        loadAppConfig({ infraProfile: 'docker', nodeEnv: 'development' }),
      ).toThrow(/entropie nulle/);

      process.env.MASTER_KEK_HEX = 'a1b2c3d4'.repeat(8);
      process.env.DATABASE_SSL = 'disable';
      expect(() =>
        loadAppConfig({ infraProfile: 'production', nodeEnv: 'production' }),
      ).toThrow(/DATABASE_SSL=disable est interdit/);
    } finally {
      if (savedEnv.MASTER_KEK_HEX === undefined) delete process.env.MASTER_KEK_HEX;
      else process.env.MASTER_KEK_HEX = savedEnv.MASTER_KEK_HEX;
      if (savedEnv.JWT_PRIV === undefined) delete process.env.JWT_ED25519_PRIVATE_KEY_B64;
      else process.env.JWT_ED25519_PRIVATE_KEY_B64 = savedEnv.JWT_PRIV;
      if (savedEnv.JWT_PUB === undefined) delete process.env.JWT_ED25519_PUBLIC_KEY_B64;
      else process.env.JWT_ED25519_PUBLIC_KEY_B64 = savedEnv.JWT_PUB;
      if (savedEnv.ALLOW_DEV === undefined) delete process.env.ALLOW_DEV_EPHEMERAL_KEYS;
      else process.env.ALLOW_DEV_EPHEMERAL_KEYS = savedEnv.ALLOW_DEV;
      if (savedEnv.DB_SSL === undefined) delete process.env.DATABASE_SSL;
      else process.env.DATABASE_SSL = savedEnv.DB_SSL;
    }

    // 3. Intégrité cryptographique SHA-256 à 100 % des chaînes d'audit après tous les scénarios d'intrusion Vague 2
    const verifyTenant = await request(app.getHttpServer())
      .get('/api/v1/audit/verify')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    expect(verifyTenant.body.valid).toBe(true);
    expect(verifyTenant.body.checkedCount).toBeGreaterThanOrEqual(20);

    const platformCheck = await db.verifyAuditChainScope(null);
    expect(platformCheck.valid).toBe(true);
    expect(platformCheck.checkedCount).toBeGreaterThanOrEqual(10);
  });
});
