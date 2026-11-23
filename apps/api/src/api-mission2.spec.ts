import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode, sha256Hex } from '@nexus-rh/crypto-audit';
import { loadAppConfig } from './config/app-config';
import { createNexusApiApp } from './app.factory';

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

describe('@nexus-rh/api — Intégration Mission 2 (Employés RDC, Matricules Atomiques, PII AES-256-GCM, Contrats, Badges QR+PIN Argon2id, Coffre S3, Consentements & Anti-IDOR)', () => {
  let app: INestApplication;
  let tempStorageDir = '';

  let superAdminToken = '';
  let tenantAId = '';
  let siteAKinId = '';
  let siteALubId = '';
  let adminAToken = '';
  let hrAToken = '';
  let chefLubToken = '';
  let readerNoSalaryToken = '';

  let tenantBId = '';
  let siteBKwzId = '';
  let hrBToken = '';

  let posCadreId = '';
  let empKin1Id = '';
  let empKin2Id = '';
  let empLubId = '';
  let empBetaId = '';

  let activeBadgeId = '';
  let activeQrPayload = '';
  let signedConsentDocId = '';
  let bioConsentId = '';

  beforeAll(async () => {
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rh-m2-s3-'));
    process.env.SANDBOX_STORAGE_DIR = tempStorageDir;

    const config = loadAppConfig({
      infraProfile: 'sandbox',
      pgliteDataDir: 'memory://',
    });
    app = await createNexusApiApp(config);

    // 1. Bootstrap Super-Admin + 2 entreprises RDC isolées (Alpha multi-sites Kinshasa/Lubumbashi, Beta Kolwezi)
    const boot = await request(app.getHttpServer())
      .post('/api/v1/auth/bootstrap')
      .send({
        fullName: 'Super Admin M2 Test',
        email: 'sa.m2@nexus-test.invalid',
        password: 'SuperAdmin#2026!M2',
      })
      .expect(201);
    superAdminToken = await enrollAndVerifyTotp(app, boot.body.accessToken);

    const resA = await request(app.getHttpServer())
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        slug: 'alpha-rdc-m2',
        legalName: 'Alpha RDC Test SARL',
        legalForm: 'SARL',
        sectorCode: 'INDUSTRY',
        defaultCurrency: 'CDF',
        matriculePattern: '{SITE}-{YYYY}-{SEQ:5}',
        isDemoTenant: true,
        headquartersSite: {
          code: 'KIN',
          name: 'Siège Kinshasa Gombe',
          province: 'Kinshasa',
          city: 'Kinshasa',
          timezone: 'Africa/Kinshasa',
        },
        initialAdmin: {
          fullName: 'Admin Alpha M2',
          email: 'admin.a.m2@nexus-test.invalid',
          password: 'AdminAlpha#2026!M2',
        },
      })
      .expect(201);
    tenantAId = resA.body.tenant.id;
    siteAKinId = resA.body.headquartersSite.id;

    const resB = await request(app.getHttpServer())
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        slug: 'beta-rdc-m2',
        legalName: 'Beta Katanga Test SA',
        legalForm: 'SA',
        sectorCode: 'MINING',
        defaultCurrency: 'USD',
        matriculePattern: '{SITE}-{YYYY}-{SEQ:5}',
        isDemoTenant: true,
        headquartersSite: {
          code: 'KWZ',
          name: 'Site Kolwezi',
          province: 'Lualaba',
          city: 'Kolwezi',
          timezone: 'Africa/Lubumbashi',
        },
        initialAdmin: {
          fullName: 'Admin Beta M2',
          email: 'admin.b.m2@nexus-test.invalid',
          password: 'AdminBeta#2026!M2',
        },
      })
      .expect(201);
    tenantBId = resB.body.tenant.id;
    siteBKwzId = resB.body.headquartersSite.id;

    // Connexion Admin A & ajout site Lubumbashi + création HR_MANAGER, SITE_MANAGER (Lubumbashi), et lecteur contrats sans accès salaires
    const loginAdminA = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'admin.a.m2@nexus-test.invalid', password: 'AdminAlpha#2026!M2' })
      .expect(200);
    adminAToken = await enrollAndVerifyTotp(app, loginAdminA.body.accessToken);

    const addLub = await request(app.getHttpServer())
      .post('/api/v1/sites')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'LUB',
        name: 'Succursale Lubumbashi',
        siteType: 'BRANCH',
        province: 'Haut-Katanga',
        city: 'Lubumbashi',
        timezone: 'Africa/Lubumbashi',
      })
      .expect(201);
    siteALubId = addLub.body.site.id;

    const rolesRes = await request(app.getHttpServer())
      .get('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    const roleMap = new Map<string, string>(
      rolesRes.body.roles.map((r: { code: string; id: string }) => [r.code, r.id]),
    );

    const noSalaryRole = await request(app.getHttpServer())
      .post('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        code: 'ADMIN_CONTRACTS_NO_SALARY',
        name: 'Assistant Contrats (Sans Salaire)',
        permissions: ['employees.read', 'contracts.read'],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'drh.a@nexus-test.invalid',
        fullName: 'DRH Alpha Test',
        password: 'DrhAlpha#2026!Valid',
        roleId: roleMap.get('HR_MANAGER'),
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'chef.lub.m2@nexus-test.invalid',
        fullName: 'Chef Site Lubumbashi M2',
        password: 'ChefLubM2#2026!Valid',
        roleId: roleMap.get('SITE_MANAGER'),
        scopeType: 'SELECTED_SITES',
        siteIds: [siteALubId],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: 'assistant.rh@nexus-test.invalid',
        fullName: 'Assistant Contrats Test',
        password: 'AssistRh#2026!Valid',
        roleId: noSalaryRole.body.role.id,
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    hrAToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'drh.a@nexus-test.invalid', password: 'DrhAlpha#2026!Valid' })
        .expect(200)
    ).body.accessToken;

    chefLubToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'chef.lub.m2@nexus-test.invalid', password: 'ChefLubM2#2026!Valid' })
        .expect(200)
    ).body.accessToken;

    readerNoSalaryToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'assistant.rh@nexus-test.invalid', password: 'AssistRh#2026!Valid' })
        .expect(200)
    ).body.accessToken;

    // Création DRH sur Tenant B (après enrôlement MFA obligatoire de l'Admin Beta)
    const loginAdminB = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'admin.b.m2@nexus-test.invalid', password: 'AdminBeta#2026!M2' })
      .expect(200);
    const adminBToken = await enrollAndVerifyTotp(app, loginAdminB.body.accessToken);

    await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({
        email: 'drh.b@nexus-test.invalid',
        fullName: 'DRH Beta Test',
        password: 'DrhBeta#2026!Valid1',
        roleId: roleMap.get('HR_MANAGER'),
        scopeType: 'ALL_SITES',
      })
      .expect(201);

    hrBToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'drh.b@nexus-test.invalid', password: 'DrhBeta#2026!Valid1' })
        .expect(200)
    ).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.SANDBOX_STORAGE_DIR;
    if (tempStorageDir && fs.existsSync(tempStorageDir)) {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    }
  });

  it('démarre sans aucun employé fictif et expose les 18 tables FORCE RLS actives', async () => {
    const health = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(health.body.mission).toBe('M2_CORE_HR');
    expect(health.body.components.database.forceRlsTablesCount).toBe(18);
    expect(
      health.body.governance.biometricConnectors.every(
        (c: { operationalOnRealHardware: boolean }) => c.operationalOnRealHardware === false,
      ),
    ).toBe(true);

    const listA = await request(app.getHttpServer())
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${hrAToken}`)
      .expect(200);
    expect(listA.body.employees).toEqual([]);
  });

  it('alloue des matricules strictement atomiques sans collision concurrente, chiffre les PII/IBAN en AES-256-GCM et bloque les doublons CNSS par index aveugle HMAC', async () => {
    // Création d'un poste RDC
    const posRes = await request(app.getHttpServer())
      .post('/api/v1/job-positions')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        code: 'ING-PROD',
        title: 'Ingénieur de Production',
        professionalCategory: 'CADRE_COLLABORATION',
      })
      .expect(201);
    posCadreId = posRes.body.jobPosition.id;

    // Création employé Kinshasa #1 avec PII et compte bancaire/Mobile Money sensibles
    const e1 = await request(app.getHttpServer())
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        primarySiteId: siteAKinId,
        jobPositionId: posCadreId,
        lastName: 'Kabongo',
        postName: 'Mutombo',
        firstName: 'Clarisse',
        gender: 'F',
        birthDate: '1991-06-14',
        birthPlace: 'Kinshasa',
        nationalityCode: 'CD',
        maritalStatus: 'MARRIED',
        hireDate: '2026-11-01',
        phonePrimary: '+243812345678',
        commune: 'Gombe',
        identityDocType: 'CARTE_ELECTEUR_CENI',
        identityDocNumber: 'CENI-9988776655',
        cnssNumber: 'CNSS-CD-44556677',
        individualTaxId: 'A2609876X',
        paymentMethod: 'BANK_TRANSFER',
        bankName: 'Rawbank SA',
        bankAccountNumber: 'CD590001100123456789012',
        mobileMoneyOperator: 'MPESA',
        mobileMoneyNumber: '+243812345678',
      })
      .expect(201);

    empKin1Id = e1.body.employee.id;
    expect(e1.body.employee.matricule).toBe('KIN-2026-00001');
    expect(e1.body.employee.attendanceMode).toBe('QR_PIN_ONLY'); // Jamais de biométrie par défaut
    expect(e1.body.employee.cnssNumberMasked).toBe('••••••••6677');
    expect(e1.body.employee.identityDocMasked).toBe('••••••••6655');
    expect(e1.body.employee.bankAccountMasked).toBe('••••••••9012');
    // Aucune donnée chiffrée brute ni en clair dans la réponse standard
    expect(e1.body.employee.encryptedPii).toBeUndefined();
    expect(e1.body.employee.encryptedPayment).toBeUndefined();
    expect(e1.body.employee.cnssBlindIndex).toBeUndefined();
    expect(e1.body.employee.cnssNumber).toBeUndefined();

    // Création concurrente de 4 autres employés Kinshasa + 1 Lubumbashi -> zéro collision de matricule
    const concurrent = await Promise.all([
      ...[2, 3, 4, 5].map((idx) =>
        request(app.getHttpServer())
          .post('/api/v1/employees')
          .set('Authorization', `Bearer ${hrAToken}`)
          .send({
            primarySiteId: siteAKinId,
            lastName: `AgentTest${idx}`,
            firstName: `Prenom${idx}`,
            gender: idx % 2 === 0 ? 'M' : 'F',
            birthDate: '1993-03-10',
            hireDate: '2026-11-02',
          })
          .expect(201),
      ),
      request(app.getHttpServer())
        .post('/api/v1/employees')
        .set('Authorization', `Bearer ${hrAToken}`)
        .send({
          primarySiteId: siteALubId,
          lastName: 'Ilunga',
          postName: 'Kasongo',
          firstName: 'Patrick',
          gender: 'M',
          birthDate: '1989-09-22',
          hireDate: '2026-11-02',
          paymentMethod: 'MOBILE_MONEY',
          mobileMoneyOperator: 'AIRTEL_MONEY',
          mobileMoneyNumber: '+243991122334',
        })
        .expect(201),
    ]);

    const kinMatricules = concurrent.slice(0, 4).map((r) => r.body.employee.matricule).sort();
    expect(kinMatricules).toEqual([
      'KIN-2026-00002',
      'KIN-2026-00003',
      'KIN-2026-00004',
      'KIN-2026-00005',
    ]);
    empKin2Id = concurrent[0]!.body.employee.id;
    empLubId = concurrent[4]!.body.employee.id;
    expect(concurrent[4]!.body.employee.matricule).toBe('LUB-2026-00001');

    // Doublon CNSS intra-tenant bloqué via index aveugle HMAC (409)
    const dupCnss = await request(app.getHttpServer())
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        primarySiteId: siteAKinId,
        lastName: 'Doublon',
        firstName: 'Test',
        gender: 'M',
        birthDate: '1990-01-01',
        hireDate: '2026-11-03',
        cnssNumber: 'cnss cd 44556677',
      })
      .expect(409);
    expect(dupCnss.body.code).toBe('EMPLOYEE_CNSS_DUPLICATE');

    // Tenant B crée son propre employé : séquence indépendante KWZ-2026-00001
    const eb = await request(app.getHttpServer())
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrBToken}`)
      .send({
        primarySiteId: siteBKwzId,
        lastName: 'Mwamba',
        firstName: 'Jean',
        gender: 'M',
        birthDate: '1988-05-12',
        hireDate: '2026-11-03',
        cnssNumber: 'CNSS-CD-44556677', // Aucun conflit inter-tenant
      })
      .expect(201);
    empBetaId = eb.body.employee.id;
    expect(eb.body.employee.matricule).toBe('KWZ-2026-00001');

    // Déchiffrement audité réservé à employees.pii.read
    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empLubId}/sensitive`)
      .set('Authorization', `Bearer ${chefLubToken}`)
      .expect(403);

    const revealed = await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKin1Id}/sensitive`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .expect(200);
    expect(revealed.body.sensitive.cnssNumber).toBe('CNSS-CD-44556677');
    expect(revealed.body.sensitive.identityDocNumber).toBe('CENI-9988776655');
    expect(revealed.body.sensitive.individualTaxId).toBe('A2609876X');
    expect(revealed.body.sensitive.payment.bankAccountNumber).toBe('CD590001100123456789012');
  });

  it('bloque strictement tous les accès IDOR inter-entreprises (RLS) et inter-établissements (SiteScope)', async () => {
    // DRH Alpha tente de lire l'employé de Beta -> 404 (filtré par PostgreSQL FORCE RLS)
    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empBetaId}`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .expect(404);

    // DRH Beta tente de lire/modifier/déchiffrer l'employé d'Alpha -> 404
    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKin1Id}`)
      .set('Authorization', `Bearer ${hrBToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKin1Id}/sensitive`)
      .set('Authorization', `Bearer ${hrBToken}`)
      .expect(404);

    // Chef de site Lubumbashi ne voit QUE l'employé de Lubumbashi (jamais les 5 de Kinshasa)
    const lubList = await request(app.getHttpServer())
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${chefLubToken}`)
      .expect(200);
    expect(lubList.body.employees).toHaveLength(1);
    expect(lubList.body.employees[0].id).toBe(empLubId);

    // IDOR horizontal : Chef Lubumbashi tente de lire un employé de Kinshasa -> 403 SITE_SCOPE_DENIED
    const idorRes = await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKin1Id}`)
      .set('Authorization', `Bearer ${chefLubToken}`)
      .expect(403);
    expect(idorRes.body.code).toBe('SITE_SCOPE_DENIED');
  });

  it('gère les ayants droit RDC et les contrats de travail (salaire chiffré, unicité contrat actif, alertes CDD/ONEM)', async () => {
    // Ajout de 2 ayants droit fiscaux -> compteur mis à jour automatiquement
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/dependents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ fullName: 'Mutombo Marc', relationship: 'SPOUSE', isTaxDependent: true })
      .expect(201);
    const dep2 = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/dependents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        fullName: 'Mutombo Grâce',
        relationship: 'CHILD_LEGITIMATE',
        birthDate: '2020-02-10',
        isTaxDependent: true,
      })
      .expect(201);
    expect(dep2.body.taxDependentsCount).toBe(2);

    // Rejet CDI avec date de fin (règle Code du Travail RDC)
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/contracts`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        contractNumber: 'CTR-INVALID',
        contractType: 'CDI',
        siteId: siteAKinId,
        startDate: '2026-11-01',
        endDate: '2027-11-01',
        payCurrency: 'USD',
        baseSalary: '1850.50',
        hiringPlace: 'Kinshasa',
      })
      .expect(400);

    // Création CDD initial avec alerte renouvellement > 1 & rappel visa ONEM
    const cdd = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/contracts`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        contractNumber: 'CTR-2026-001',
        contractType: 'CDD',
        siteId: siteAKinId,
        jobPositionId: posCadreId,
        startDate: '2026-11-01',
        endDate: '2027-04-30',
        cddRenewalCount: 2,
        weeklyHours: 45,
        payCurrency: 'USD',
        payFrequency: 'MONTHLY',
        baseSalary: '1850.50',
        hiringPlace: 'Kinshasa',
        status: 'ACTIVE',
      })
      .expect(201);
    expect(cdd.body.contract.baseSalary).toBe('1850.50');
    expect(cdd.body.contract.encryptedBaseSalary).toBeUndefined();
    expect(cdd.body.complianceAdvisories.length).toBeGreaterThanOrEqual(2);

    // Interdiction d'un second contrat ACTIVE simultané sur le même agent -> 409
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/contracts`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        contractNumber: 'CTR-2026-002',
        contractType: 'CDI',
        siteId: siteAKinId,
        startDate: '2026-11-15',
        payCurrency: 'CDF',
        baseSalary: '4500000',
        hiringPlace: 'Kinshasa',
        onemVisaRef: 'ONEM/KIN/2026/991',
        status: 'ACTIVE',
      })
      .expect(409);

    // Masquage strict du salaire pour un utilisateur ayant contracts.read SANS employees.salary.read
    const redactedList = await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKin1Id}/contracts`)
      .set('Authorization', `Bearer ${readerNoSalaryToken}`)
      .expect(200);
    expect(redactedList.body.contracts).toHaveLength(1);
    expect(redactedList.body.contracts[0].baseSalary).toBeNull();
    expect(redactedList.body.contracts[0].salaryRedacted).toBe(true);

    // Clôture du CDD arrivé à terme puis activation d'un CDI visé ONEM en CDF
    await request(app.getHttpServer())
      .patch(`/api/v1/employees/${empKin1Id}/contracts/${cdd.body.contract.id}/status`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        status: 'EXPIRED',
        reason: 'Échéance du CDD et passage en CDI définitif',
      })
      .expect(200);

    const cdi = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/contracts`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        contractNumber: 'CTR-2026-002-CDI',
        contractType: 'CDI',
        siteId: siteAKinId,
        jobPositionId: posCadreId,
        startDate: '2026-11-15',
        weeklyHours: 45,
        payCurrency: 'CDF',
        payFrequency: 'MONTHLY',
        baseSalary: '4850000.00',
        hiringPlace: 'Kinshasa',
        onemVisaRef: 'ONEM/KIN/2026/991',
        status: 'ACTIVE',
      })
      .expect(201);
    expect(cdi.body.contract.contractType).toBe('CDI');
    expect(cdi.body.contract.baseSalary).toBe('4850000.00');
    expect(cdi.body.complianceAdvisories).toEqual([]);
  });

  it('émet un badge QR signé + PIN Argon2id, valide le pointage alternatif, verrouille après 5 échecs et révoque proprement', async () => {
    // Rejet des PIN triviaux (123456, 000000)
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/badges`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ pin: '123456' })
      .expect(400);

    // Émission d'un badge valide avec PIN fort haché Argon2id 64 MiB
    const issued = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/badges`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ pin: '482915', expiresAt: '2027-12-31' })
      .expect(201);

    activeBadgeId = issued.body.badge.id;
    activeQrPayload = issued.body.qrPayloadOnce;
    expect(activeQrPayload).toMatch(/^NXRH1\./);
    expect(issued.body.badge.pinArgon2Hash).toBeUndefined();
    expect(issued.body.badge.qrTokenHash).toBeUndefined();

    // Vérification QR + PIN réussie sur le site Kinshasa
    const verified = await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ qrPayload: activeQrPayload, pin: '482915', siteId: siteAKinId })
      .expect(200);
    expect(verified.body.verified).toBe(true);
    expect(verified.body.method).toBe('QR_AND_ARGON2ID_PIN');
    expect(verified.body.employee.matricule).toBe('KIN-2026-00001');
    expect(verified.body.site.timezone).toBe('Africa/Kinshasa');

    // Rejet sur un autre site (Lubumbashi) et sur un autre tenant (Beta)
    await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ qrPayload: activeQrPayload, pin: '482915', siteId: siteALubId })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrBToken}`)
      .send({ qrPayload: activeQrPayload, pin: '482915', siteId: siteBKwzId })
      .expect(401);

    // Rejet falsification de signature QR
    const forgedQr = `${activeQrPayload.slice(0, -2)}ZZ`;
    await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ qrPayload: forgedQr, pin: '482915', siteId: siteAKinId })
      .expect(401);

    // 5 codes PIN erronés consécutifs -> verrouillage anti-bruteforce (429 BADGE_PIN_LOCKED)
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/badges/verify-qr-pin')
        .set('Authorization', `Bearer ${hrAToken}`)
        .send({ qrPayload: activeQrPayload, pin: '917382', siteId: siteAKinId })
        .expect(401);
    }

    const locked = await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ qrPayload: activeQrPayload, pin: '482915', siteId: siteAKinId })
      .expect(429);
    expect(locked.body.code).toBe('BADGE_PIN_LOCKED');

    // Réinitialisation du PIN par la DRH -> déverrouille le badge et valide le nouveau PIN
    await request(app.getHttpServer())
      .patch(`/api/v1/employees/${empKin1Id}/badges/${activeBadgeId}/pin`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ newPin: '739184', reason: 'Déverrouillage et réinitialisation demandés par l’agent' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ qrPayload: activeQrPayload, pin: '739184', siteId: siteAKinId })
      .expect(200);

    // Révocation explicite pour perte -> ancien QR immédiatement inutilisable (401)
    await request(app.getHttpServer())
      .patch(`/api/v1/employees/${empKin1Id}/badges/${activeBadgeId}/revoke`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ status: 'LOST', reason: 'Déclaration de perte de la carte physique par l’agent' })
      .expect(200);

    const revokedAttempt = await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ qrPayload: activeQrPayload, pin: '739184', siteId: siteAKinId })
      .expect(401);
    expect(revokedAttempt.body.code).toBe('BADGE_INACTIVE_OR_REVOKED');

    // Réémission d'un nouveau badge actif de remplacement
    const reissued = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/badges`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        pin: '739184',
        replaceReason: 'Nouveau badge émis après déclaration de perte',
      })
      .expect(201);
    activeBadgeId = reissued.body.badge.id;
    activeQrPayload = reissued.body.qrPayloadOnce;
  });

  it('chiffre les pièces du coffre S3 en AES-256-GCM, vérifie magic-bytes et SHA-256, et bloque les IDOR documentaires', async () => {
    // Rejet d'un script HTML déguisé en PDF
    const fakePdfB64 = Buffer.from('<script>alert(1)</script>', 'utf8').toString('base64');
    const badMime = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/documents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        category: 'IDENTITY_DOC',
        title: 'Faux PDF',
        originalFilename: 'piege.pdf',
        mimeType: 'application/pdf',
        contentBase64: fakePdfB64,
      })
      .expect(400);
    expect(badMime.body.code).toBe('DOCUMENT_MAGIC_BYTES_MISMATCH');

    // Téléversement d'un vrai document PDF de consentement signé
    const pdfBytes = Buffer.from(
      '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n% Formulaire signe consentement RDC\n%%EOF\n',
      'utf8',
    );
    const expectedSha = sha256Hex(pdfBytes);

    const up = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/documents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        category: 'SIGNED_CONSENT',
        title: 'Consentement biométrique local signé',
        originalFilename: 'consentement-kabongo-2026.pdf',
        mimeType: 'application/pdf',
        contentBase64: pdfBytes.toString('base64'),
        retentionUntil: '2031-11-17',
      })
      .expect(201);

    signedConsentDocId = up.body.document.id;
    expect(up.body.document.sha256Checksum).toBe(expectedSha);
    expect(up.body.document.isEnvelopeEncrypted).toBe(true);
    expect(
      up.body.document.objectKey.startsWith(`tenants/${tenantAId}/employees/${empKin1Id}/documents/`),
    ).toBe(true);

    // Vérification physique sur disque : l'objet stocké est chiffré AES-256-GCM (jamais %PDF en clair)
    const storedOnDisk = fs.readFileSync(path.join(tempStorageDir, up.body.document.objectKey), 'utf8');
    expect(storedOnDisk).not.toContain('%PDF-1.7');
    expect(storedOnDisk).toContain('wrappedDekB64');

    // Téléchargement autorisé : déchiffrement + contrôle SHA-256 exact
    const dl = await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKin1Id}/documents/${signedConsentDocId}/download`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .expect(200);
    expect(dl.body.document.sha256Verified).toBe(true);
    expect(Buffer.from(dl.body.contentBase64, 'base64').equals(pdfBytes)).toBe(true);

    // IDOR inter-employés au sein du MÊME tenant : tenter de télécharger le doc d'emp1 via emp2 -> 404
    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKin2Id}/documents/${signedConsentDocId}/download`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .expect(404);

    // IDOR inter-tenants : DRH Beta tente de télécharger le document -> 404
    await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKin1Id}/documents/${signedConsentDocId}/download`)
      .set('Authorization', `Bearer ${hrBToken}`)
      .expect(404);
  });

  it('applique la gouvernance des consentements RDC (zéro pré-cochage, blocage central sous DEVICE_ONLY, retrait immédiat avec alternative QR+PIN intacte)', async () => {
    // Aucun consentement pré-existant
    const initial = await request(app.getHttpServer())
      .get(`/api/v1/employees/${empKin1Id}/consents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .expect(200);
    expect(initial.body.consents).toEqual([]);

    // Rejet si alternativeQrPinOffered n'est pas confirmé explicitement à true
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/consents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        consentType: 'BIOMETRIC_DEVICE_ONLY',
        decision: 'GRANTED',
        policyVersion: 'RDC-2026.1',
        collectionMethod: 'WRITTEN_SIGNED_UPLOAD',
        noticeSummary: 'Notice d’information biométrie locale sur terminal uniquement.',
        alternativeQrPinOffered: false,
        signedDocumentId: signedConsentDocId,
      })
      .expect(400);

    // Blocage strict de BIOMETRIC_CENTRAL_TEMPLATE = GRANTED tant que le tenant est en DEVICE_ONLY (403)
    const centralBlocked = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/consents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        consentType: 'BIOMETRIC_CENTRAL_TEMPLATE',
        decision: 'GRANTED',
        policyVersion: 'RDC-2026.1',
        collectionMethod: 'WRITTEN_SIGNED_UPLOAD',
        noticeSummary: 'Tentative stockage central sans autorisation APD du tenant.',
        alternativeQrPinOffered: true,
        signedDocumentId: signedConsentDocId,
      })
      .expect(403);
    expect(centralBlocked.body.code).toBe('CENTRAL_BIOMETRIC_FORBIDDEN_BY_TENANT_POLICY');

    // Enregistrement explicite d'un consentement BIOMETRIC_DEVICE_ONLY signé
    const granted = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/consents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        consentType: 'BIOMETRIC_DEVICE_ONLY',
        decision: 'GRANTED',
        policyVersion: 'RDC-2026.1',
        collectionMethod: 'WRITTEN_SIGNED_UPLOAD',
        noticeSummary:
          'Consentement libre et éclairé pour pointage sur terminal local uniquement ; badge QR+PIN disponible à tout moment.',
        alternativeQrPinOffered: true,
        signedDocumentId: signedConsentDocId,
      })
      .expect(201);
    bioConsentId = granted.body.consent.id;
    expect(granted.body.employeeAttendanceMode).toBe('BIOMETRIC_OR_QR_PIN');

    // Protection de la preuve légale : impossible de supprimer le PDF signé rattaché au consentement -> 409
    const delLocked = await request(app.getHttpServer())
      .delete(`/api/v1/employees/${empKin1Id}/documents/${signedConsentDocId}`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ reason: 'Tentative suppression preuve consentement' })
      .expect(409);
    expect(delLocked.body.code).toBe('DOCUMENT_LOCKED_BY_LEGAL_CONSENT');

    // Retrait du consentement biométrique par l'agent -> retour immédiat en QR_PIN_ONLY SANS pénalité
    const withdrawn = await request(app.getHttpServer())
      .post(`/api/v1/employees/${empKin1Id}/consents/${bioConsentId}/withdraw`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ reason: 'Retrait libre demandé par l’agent — préférence badge QR+PIN' })
      .expect(200);
    expect(withdrawn.body.employeeAttendanceMode).toBe('QR_PIN_ONLY');

    // L'alternative QR + PIN demeure immédiatement et pleinement fonctionnelle après retrait du consentement !
    const qrStillWorks = await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ qrPayload: activeQrPayload, pin: '739184', siteId: siteAKinId })
      .expect(200);
    expect(qrStillWorks.body.verified).toBe(true);
    expect(qrStillWorks.body.employee.attendanceMode).toBe('QR_PIN_ONLY');

    // Clôture du dossier employé (TERMINATED) -> révoque automatiquement son badge et son contrat actifs
    await request(app.getHttpServer())
      .patch(`/api/v1/employees/${empKin1Id}`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        status: 'TERMINATED',
        terminationDate: '2026-11-30',
        terminationReason: 'Démission volontaire avec préavis légal respecté.',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/badges/verify-qr-pin')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ qrPayload: activeQrPayload, pin: '739184', siteId: siteAKinId })
      .expect(401);
  });

  it('garantit l’intégrité SHA-256 intégrale du journal d’audit et zéro fuite de PII/salaire/PIN/QR dans les logs', async () => {
    const verifyA = await request(app.getHttpServer())
      .get('/api/v1/audit/verify')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    expect(verifyA.body.valid).toBe(true);
    expect(verifyA.body.checkedCount).toBeGreaterThanOrEqual(20);

    const logsRes = await request(app.getHttpServer())
      .get('/api/v1/audit/logs?limit=100')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);

    const serializedLogs = JSON.stringify(logsRes.body.logs);
    expect(serializedLogs).toContain('EMPLOYEE_CREATED');
    expect(serializedLogs).toContain('EMPLOYEE_SENSITIVE_PII_ACCESSED');
    expect(serializedLogs).toContain('EMPLOYMENT_CONTRACT_CREATED');
    expect(serializedLogs).toContain('EMPLOYEE_BADGE_ISSUED');
    expect(serializedLogs).toContain('BADGE_QR_PIN_VERIFIED');
    expect(serializedLogs).toContain('BADGE_PIN_LOCKED');
    expect(serializedLogs).toContain('EMPLOYEE_DOCUMENT_UPLOADED');
    expect(serializedLogs).toContain('EMPLOYEE_DOCUMENT_DOWNLOADED');
    expect(serializedLogs).toContain('EMPLOYEE_CONSENT_RECORDED');
    expect(serializedLogs).toContain('EMPLOYEE_CONSENT_WITHDRAWN');
    expect(serializedLogs).toContain('EMPLOYEE_TERMINATED');

    // Aucune donnée sensible en clair dans le journal d'audit
    expect(serializedLogs).not.toContain('CNSS-CD-44556677');
    expect(serializedLogs).not.toContain('CENI-9988776655');
    expect(serializedLogs).not.toContain('CD590001100123456789012');
    expect(serializedLogs).not.toContain('1850.50');
    expect(serializedLogs).not.toContain('4850000.00');
    expect(serializedLogs).not.toContain('482915');
    expect(serializedLogs).not.toContain('739184');
    expect(serializedLogs).not.toContain(activeQrPayload);
  });

  it('applique en bout-en-bout les correctifs Vague 1 : dates ISO strictes (F-04), âge révolu/CDD/journalier/essai/expatrié/preuve biométrique (G-01) et anti-doublon concurrent des consentements (N-01)', async () => {
    // 1. F-04 : dates calendaires impossibles rejetées proprement en 400 (jamais 500)
    for (const badDate of ['2026-02-29', '2026-02-31', '2026-04-31', '1900-02-29']) {
      await request(app.getHttpServer())
        .post('/api/v1/employees')
        .set('Authorization', `Bearer ${hrAToken}`)
        .send({
          primarySiteId: siteAKinId,
          lastName: 'DATEINVALIDE',
          firstName: 'Test',
          gender: 'M',
          birthDate: '1992-05-10',
          hireDate: badDate,
        })
        .expect(400);
    }

    // 2. G-01 : rejet d'un mineur de 15 ans et 2 jours (même si 2026 - 2010 = 16)
    await request(app.getHttpServer())
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        primarySiteId: siteAKinId,
        lastName: 'MINEUR',
        firstName: 'Junior',
        gender: 'M',
        birthDate: '2010-12-31',
        hireDate: '2026-01-02',
      })
      .expect(400);

    // 3. F-04 (année bissextile 2000-02-29) + G-01 (ressortissant étranger avec permis de travail daté,
    //    sans déduction automatique de isExpatriate -> reste null tant que non qualifié)
    const createdExpat = await request(app.getHttpServer())
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        primarySiteId: siteAKinId,
        lastName: 'VAN DER BERG',
        firstName: 'Lucas',
        gender: 'M',
        birthDate: '2000-02-29',
        nationalityCode: 'BE',
        hireDate: '2025-01-01',
        identityDocType: 'PERMIS_TRAVAIL_ETRANGER',
        identityDocNumber: 'PTE-KIN-2025-9012',
        identityDocExpiresAt: '2027-12-31',
      })
      .expect(201);

    const expatEmpId = createdExpat.body.employee.id as string;
    expect(createdExpat.body.employee.isExpatriate).toBeNull();
    expect(createdExpat.body.employee.identityDocExpiresAt).toBe('2027-12-31');

    // Qualification explicite par le service RH après validation
    const patchedExpat = await request(app.getHttpServer())
      .patch(`/api/v1/employees/${expatEmpId}`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ isExpatriate: true })
      .expect(200);
    expect(patchedExpat.body.employee.isExpatriate).toBe(true);

    // 4. G-01 contrats : probationEndDate > endDate rejeté en 400 ; CDD 24 mois + 1 jour (731 j hors bissextile)
    //    et période d'essai > 6 mois signalés en alertes consultatives non bloquantes ; rappel JOURNALIER
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${expatEmpId}/contracts`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        contractNumber: 'CDD-BAD-PROB-01',
        contractType: 'CDD',
        siteId: siteAKinId,
        startDate: '2025-01-01',
        endDate: '2025-06-30',
        probationEndDate: '2025-09-01',
        payCurrency: 'USD',
        baseSalary: '2500.00',
        hiringPlace: 'Kinshasa',
        status: 'DRAFT',
      })
      .expect(400);

    const cddAdvisoryRes = await request(app.getHttpServer())
      .post(`/api/v1/employees/${expatEmpId}/contracts`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        contractNumber: 'CDD-V1-731D',
        contractType: 'CDD',
        siteId: siteAKinId,
        startDate: '2025-01-01',
        endDate: '2027-01-02', // 24 mois + 1 jour sur deux années non bissextiles (731 jours)
        probationEndDate: '2025-08-15', // > 6 mois calendaires
        payCurrency: 'USD',
        baseSalary: '2500.00',
        hiringPlace: 'Kinshasa',
        onemVisaRef: 'ONEM-KIN-2025-77',
        status: 'DRAFT',
      })
      .expect(201);
    expect(JSON.stringify(cddAdvisoryRes.body.complianceAdvisories)).toContain('24 mois');
    expect(JSON.stringify(cddAdvisoryRes.body.complianceAdvisories)).toContain('6 mois');

    const journalierRes = await request(app.getHttpServer())
      .post(`/api/v1/employees/${expatEmpId}/contracts`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        contractNumber: 'JRN-V1-001',
        contractType: 'JOURNALIER',
        siteId: siteAKinId,
        startDate: '2026-11-17',
        payCurrency: 'CDF',
        payFrequency: 'DAILY',
        baseSalary: '45000.00',
        hiringPlace: 'Kinshasa',
        status: 'DRAFT',
      })
      .expect(201);
    expect(JSON.stringify(journalierRes.body.complianceAdvisories)).toContain('journalier');

    // 5. G-01 consentement biométrique local : refusé sans signedDocumentId ou avec mauvaise catégorie
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${expatEmpId}/consents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        consentType: 'BIOMETRIC_DEVICE_ONLY',
        decision: 'GRANTED',
        policyVersion: 'RDC-2026.1',
        collectionMethod: 'HR_ATTESTED_PAPER',
        noticeSummary: 'Notice complète d’information biométrique avec alternative QR+PIN.',
        alternativeQrPinOffered: true,
        signedDocumentId: null,
      })
      .expect(400);

    const minimalPdfBase64 = Buffer.from('%PDF-1.4\n%Preuve consentement signe V1\n%%EOF').toString(
      'base64',
    );
    const idDocRes = await request(app.getHttpServer())
      .post(`/api/v1/employees/${expatEmpId}/documents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        category: 'IDENTITY_DOC',
        title: 'Permis de travail',
        originalFilename: 'permis.pdf',
        mimeType: 'application/pdf',
        contentBase64: minimalPdfBase64,
        expiresAt: '2027-12-31',
        retentionUntil: '2032-12-31',
      })
      .expect(201);

    const wrongCat = await request(app.getHttpServer())
      .post(`/api/v1/employees/${expatEmpId}/consents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        consentType: 'BIOMETRIC_DEVICE_ONLY',
        decision: 'GRANTED',
        policyVersion: 'RDC-2026.1',
        collectionMethod: 'HR_ATTESTED_PAPER',
        noticeSummary: 'Notice complète d’information biométrique avec alternative QR+PIN.',
        alternativeQrPinOffered: true,
        signedDocumentId: idDocRes.body.document.id,
      })
      .expect(400);
    expect(wrongCat.body.code).toBe('SIGNED_CONSENT_CATEGORY_REQUIRED');

    // 6. N-01 : 5 enregistrements concurrents BIOMETRIC_DEVICE_ONLY GRANTED sur le même salarié ->
    //    strictement 1 seul GRANTED actif, les 4 autres conservés en WITHDRAWN (zéro perte d'historique)
    const consentDocRes = await request(app.getHttpServer())
      .post(`/api/v1/employees/${expatEmpId}/documents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({
        category: 'SIGNED_CONSENT',
        title: 'Formulaire consentement biométrique signé',
        originalFilename: 'consent-v1.pdf',
        mimeType: 'application/pdf',
        contentBase64: minimalPdfBase64,
        retentionUntil: '2032-12-31',
      })
      .expect(201);

    const concurrentResponses = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        request(app.getHttpServer())
          .post(`/api/v1/employees/${expatEmpId}/consents`)
          .set('Authorization', `Bearer ${hrAToken}`)
          .send({
            consentType: 'BIOMETRIC_DEVICE_ONLY',
            decision: 'GRANTED',
            policyVersion: `RDC-2026.${idx + 1}`,
            collectionMethod: 'WRITTEN_SIGNED_UPLOAD',
            noticeSummary: `Notice d’information biométrique locale signée #${idx + 1} (QR+PIN garanti).`,
            alternativeQrPinOffered: true,
            signedDocumentId: consentDocRes.body.document.id,
          }),
      ),
    );

    for (const r of concurrentResponses) {
      expect([201, 409]).toContain(r.status);
    }

    const consentsAfterRace = await request(app.getHttpServer())
      .get(`/api/v1/employees/${expatEmpId}/consents`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .expect(200);

    const allConsents = consentsAfterRace.body.consents as Array<{ id: string; decision: string }>;
    const activeGranted = allConsents.filter((c) => c.decision === 'GRANTED');
    const historicalWithdrawn = allConsents.filter((c) => c.decision === 'WITHDRAWN');
    expect(activeGranted).toHaveLength(1);
    expect(allConsents.length).toBe(
      concurrentResponses.filter((r) => r.status === 201).length,
    );
    expect(historicalWithdrawn.length).toBe(allConsents.length - 1);

    // Un unique retrait ramène immédiatement l'agent en QR_PIN_ONLY (aucun doublon GRANTED fantôme)
    const afterSingleWithdraw = await request(app.getHttpServer())
      .post(`/api/v1/employees/${expatEmpId}/consents/${activeGranted[0]!.id}/withdraw`)
      .set('Authorization', `Bearer ${hrAToken}`)
      .send({ reason: 'Retrait unique suffisant — retour immédiat en QR+PIN.' })
      .expect(200);
    expect(afterSingleWithdraw.body.employeeAttendanceMode).toBe('QR_PIN_ONLY');
  });

  it('permet de réattribuer un rôle révoqué en conservant l’historique, sans doublon actif et dans le strict respect SoD (N-02)', async () => {
    const memberEmail = 'reattrib.v1@congo-mines.cd';

    const rolesCatalog = await request(app.getHttpServer())
      .get('/api/v1/rbac/roles')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    const allRoles = rolesCatalog.body.roles as Array<{ id: string; code: string }>;
    const payrollRoleId = allRoles.find((r) => r.code === 'PAYROLL_MANAGER')!.id;
    const financeRoleId = allRoles.find((r) => r.code === 'FINANCE_APPROVER')!.id;

    // 1. Attribution initiale du rôle PAYROLL_MANAGER
    const firstAssign = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: memberEmail,
        fullName: 'Nadine Kasongo',
        password: 'Nadine#Rdc2026!Safe',
        roleId: payrollRoleId,
        scopeType: 'ALL_SITES',
        siteIds: [],
      })
      .expect(201);
    const firstMembershipId = firstAssign.body.membership.id as string;

    // 2. Révocation de l'adhésion -> 200 ; seconde révocation de la même ligne -> 409
    await request(app.getHttpServer())
      .delete(`/api/v1/rbac/members/${firstMembershipId}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);

    const dupRevoke = await request(app.getHttpServer())
      .delete(`/api/v1/rbac/members/${firstMembershipId}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(409);
    expect(dupRevoke.body.code).toBe('MEMBERSHIP_ALREADY_REVOKED');

    // 3. Réattribution du MÊME rôle PAYROLL_MANAGER (échouait auparavant en 500 sur uq_membership_tenant_user_role)
    const secondAssign = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: memberEmail,
        fullName: 'Nadine Kasongo',
        roleId: payrollRoleId,
        scopeType: 'SELECTED_SITES',
        siteIds: [siteAKinId],
      })
      .expect(201);
    const secondMembershipId = secondAssign.body.membership.id as string;
    expect(secondMembershipId).not.toBe(firstMembershipId);

    // 4. Doublon actif strictement rejeté en 409 (y compris sous appels concurrents)
    const dupActive = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/rbac/members')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          email: memberEmail,
          fullName: 'Nadine Kasongo',
          roleId: payrollRoleId,
          scopeType: 'ALL_SITES',
          siteIds: [],
        }),
      request(app.getHttpServer())
        .post('/api/v1/rbac/members')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          email: memberEmail,
          fullName: 'Nadine Kasongo',
          roleId: payrollRoleId,
          scopeType: 'ALL_SITES',
          siteIds: [],
        }),
    ]);
    expect(dupActive.map((r) => r.status)).toEqual([409, 409]);

    // 5. Séparation des tâches (SoD) toujours appliquée : FINANCE_APPROVER incompatible avec PAYROLL_MANAGER actif
    const sodBlocked = await request(app.getHttpServer())
      .post('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        email: memberEmail,
        fullName: 'Nadine Kasongo',
        roleId: financeRoleId,
        scopeType: 'ALL_SITES',
        siteIds: [],
      })
      .expect(409);
    expect(sodBlocked.body.code).toBe('SOD_CONFLICT');

    // 6. Vérification de l'historique complet : 1 ligne REVOKED (avec revokedAt) + 1 seule ligne ACTIVE
    const membersRes = await request(app.getHttpServer())
      .get('/api/v1/rbac/members')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);

    const nadineRows = (
      membersRes.body.members as Array<{
        membershipId: string;
        email: string;
        status: string;
        revokedAt: string | null;
      }>
    ).filter((m) => m.email === memberEmail);
    expect(nadineRows).toHaveLength(2);
    const revokedRow = nadineRows.find((m) => m.membershipId === firstMembershipId)!;
    const activeRow = nadineRows.find((m) => m.membershipId === secondMembershipId)!;
    expect(revokedRow.status).toBe('REVOKED');
    expect(revokedRow.revokedAt).not.toBeNull();
    expect(activeRow.status).toBe('ACTIVE');
    expect(activeRow.revokedAt).toBeNull();

    // 7. Connexion effective de la membre réattribuée -> session active fonctionnelle
    const nadineLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: memberEmail, password: 'Nadine#Rdc2026!Safe' })
      .expect(200);
    expect(nadineLogin.body.status).toBe('AUTHENTICATED');

    // 8. Exécution déterministe du service NestJS OutboxRelayService (B-06) -> zéro erreur
    const { OutboxRelayService } = await import('./infra/outbox-relay.service');
    const outboxRelay = app.get(OutboxRelayService);
    const relayCheck = await outboxRelay.runOnce();
    expect(relayCheck.deadLettered).toBe(0);

    // 9. Chaîne d'audit SHA-256 du tenant intégralement valide après toutes les opérations Vague 1
    const finalAudit = await request(app.getHttpServer())
      .get('/api/v1/audit/verify')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    expect(finalAudit.body.valid).toBe(true);
  });
});
