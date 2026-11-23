import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, uuidv7 } from '@nexus-rh/crypto-audit';
import {
  NexusDatabase,
  and,
  buildPgSslConfig,
  departments,
  employeeConsents,
  employeeDocuments,
  employees,
  eq,
  outboxEvents,
  permissions,
  rolePermissions,
  roles,
  sites,
  sql,
  tenantMemberships,
  tenants,
  users,
} from './index';

describe('@nexus-rh/database — Migrations, PostgreSQL FORCE RLS, Biométrie DEVICE_ONLY & Audit Immuable', () => {
  let db: NexusDatabase;
  const testSlugSuffix = uuidv7().slice(-8);
  const tenantAId = uuidv7();
  const tenantBId = uuidv7();
  const approverUserId = uuidv7();

  beforeAll(async () => {
    const pgUrl = process.env.TEST_POSTGRES_URL?.trim();
    db = pgUrl
      ? await NexusDatabase.connect({ profile: 'docker', connectionString: pgUrl })
      : await NexusDatabase.connect({ profile: 'sandbox', pgliteDataDir: 'memory://' });

    const migrations = await db.runMigrations();
    expect(migrations.map((m) => m.filename)).toContain('0001_mission1_foundation.sql');

    // Idempotence de la ré-exécution des migrations et du catalogue système
    await db.runMigrations();
    const catalog = await db.seedSystemCatalog();
    expect(catalog.permissionsCount).toBeGreaterThanOrEqual(36);
    expect(catalog.systemRolesCount).toBe(8);
  });

  afterAll(async () => {
    await db.close();
  });

  it('active FORCE ROW LEVEL SECURITY sur les 10 tables multi-tenant de la Mission 1 et révoque UPDATE/DELETE sur audit_logs', async () => {
    const ping = await db.ping();
    expect(ping.ok).toBe(true);
    expect(ping.rlsTablesCount).toBeGreaterThanOrEqual(10);

    const privCheck = await db.withPlatformTransaction(async (tx) => {
      const res = await tx.execute<{ can_update: boolean; can_delete: boolean }>(sql`
        SELECT
          has_table_privilege('nexus_app', 'public.audit_logs', 'UPDATE') AS can_update,
          has_table_privilege('nexus_app', 'public.audit_logs', 'DELETE') AS can_delete
      `);
      return Array.isArray(res) ? res[0] : (res as { rows: Array<{ can_update: boolean; can_delete: boolean }> }).rows[0];
    });
    expect(privCheck?.can_update).toBe(false);
    expect(privCheck?.can_delete).toBe(false);
  });

  it('isole hermétiquement Tenant A (Kinshasa UTC+1) et Tenant B (Lubumbashi UTC+2) via PostgreSQL RLS', async () => {
    const pwHash = await hashPassword('TestOnly#2026!Valid');

    await db.withPlatformTransaction(async (tx) => {
      await tx.insert(users).values({
        id: approverUserId,
        email: `admin.${testSlugSuffix}@nexus-test.invalid`,
        passwordHash: pwHash,
        fullName: 'Administrateur Test Unitaire',
        isPlatformSuperadmin: true,
        mfaRequired: true,
      });

      await tx.insert(tenants).values([
        {
          id: tenantAId,
          slug: `test-alpha-${testSlugSuffix}`,
          legalName: 'Société Test Alpha SARL',
          legalForm: 'SARL',
          defaultCurrency: 'CDF',
          encryptionKeyRef: `kek-${tenantAId}`,
          isDemoTenant: true,
        },
        {
          id: tenantBId,
          slug: `test-beta-${testSlugSuffix}`,
          legalName: 'Société Test Beta SA',
          legalForm: 'SA',
          defaultCurrency: 'USD',
          encryptionKeyRef: `kek-${tenantBId}`,
          isDemoTenant: true,
        },
      ]);
    });

    const siteAId = uuidv7();
    const siteBId = uuidv7();

    await db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
      await tx.insert(sites).values({
        id: siteAId,
        tenantId: tenantAId,
        code: 'KIN-HQ',
        name: 'Siège Kinshasa (Test)',
        siteType: 'HEADQUARTERS',
        province: 'Kinshasa',
        city: 'Kinshasa',
        timezone: 'Africa/Kinshasa',
        isHeadquarters: true,
      });
      await tx.insert(departments).values({
        id: uuidv7(),
        tenantId: tenantAId,
        siteId: siteAId,
        code: 'DRH',
        name: 'Ressources Humaines',
      });
    });

    await db.withTenantTransaction(tenantBId, approverUserId, async (tx) => {
      await tx.insert(sites).values({
        id: siteBId,
        tenantId: tenantBId,
        code: 'LUB-HQ',
        name: 'Siège Lubumbashi (Test)',
        siteType: 'HEADQUARTERS',
        province: 'Haut-Katanga',
        city: 'Lubumbashi',
        timezone: 'Africa/Lubumbashi',
        isHeadquarters: true,
      });
    });

    // Requête volontairement SANS clause WHERE tenant_id : RLS ne doit retourner QUE Tenant A
    const visibleToA = await db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
      return tx.select().from(sites);
    });
    expect(visibleToA).toHaveLength(1);
    expect(visibleToA[0]?.code).toBe('KIN-HQ');
    expect(visibleToA[0]?.timezone).toBe('Africa/Kinshasa');

    // Même test pour Tenant B
    const visibleToB = await db.withTenantTransaction(tenantBId, approverUserId, async (tx) => {
      return tx.select().from(sites);
    });
    expect(visibleToB).toHaveLength(1);
    expect(visibleToB[0]?.code).toBe('LUB-HQ');
    expect(visibleToB[0]?.timezone).toBe('Africa/Lubumbashi');

    // Tentative d'injection inter-tenant : Tenant A tente d'insérer un site au nom de Tenant B -> BLOQUÉ par RLS
    await expect(
      db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
        await tx.insert(sites).values({
          id: uuidv7(),
          tenantId: tenantBId,
          code: 'INTRUSION',
          name: 'Tentative Intrusion',
          province: 'Kinshasa',
          city: 'Kinshasa',
          timezone: 'Africa/Kinshasa',
        });
      }),
    ).rejects.toThrow();

    // Tentative de création d'un département de Tenant B rattaché à un site de Tenant A -> BLOQUÉ par FK composite/RLS
    await expect(
      db.withTenantTransaction(tenantBId, approverUserId, async (tx) => {
        await tx.insert(departments).values({
          id: uuidv7(),
          tenantId: tenantBId,
          siteId: siteAId,
          code: 'CROSS',
          name: 'Cross Tenant Dept',
        });
      }),
    ).rejects.toThrow();

    // Isolation des rôles personnalisés ET de role_permissions (FORCE RLS) entre Tenant A et Tenant B
    const customRoleAId = uuidv7();
    await db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
      await tx.insert(roles).values({
        id: customRoleAId,
        tenantId: tenantAId,
        code: 'CUSTOM_HR_A',
        name: 'Assistant RH Alpha',
        isSystem: false,
      });
      const [perm] = await tx.select().from(permissions).limit(1);
      await tx.insert(rolePermissions).values({
        roleId: customRoleAId,
        permissionId: perm!.id,
      });
    });

    const rolesSeenByB = await db.withTenantTransaction(tenantBId, approverUserId, async (tx) => {
      return tx.select().from(roles);
    });
    expect(rolesSeenByB.some((r) => r.code === 'CUSTOM_HR_A')).toBe(false);
    expect(rolesSeenByB.every((r) => r.isSystem)).toBe(true);

    const rolePermsSeenByB = await db.withTenantTransaction(
      tenantBId,
      approverUserId,
      async (tx) => {
        return tx
          .select()
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, customRoleAId));
      },
    );
    expect(rolePermsSeenByB).toHaveLength(0);
  });

  it('impose DEVICE_ONLY par défaut et bloque en SQL tout stockage biométrique central non autorisé juridiquement', async () => {
    const [tenantA] = await db.withPlatformTransaction((tx) =>
      tx.select().from(tenants).where(eq(tenants.id, tenantAId)),
    );
    expect(tenantA?.biometricStoragePolicy).toBe('DEVICE_ONLY');
    expect(tenantA?.centralTemplateStorageEnabled).toBe(false);

    // Tentative 1 : activer central_template_storage_enabled en restant DEVICE_ONLY -> BLOQUÉ
    await expect(
      db.withPlatformTransaction((tx) =>
        tx
          .update(tenants)
          .set({ centralTemplateStorageEnabled: true })
          .where(eq(tenants.id, tenantAId)),
      ),
    ).rejects.toThrow();

    // Tentative 2 : passer en ENCRYPTED_CENTRAL_SYNC sans référence d'autorisation juridique -> BLOQUÉ
    await expect(
      db.withPlatformTransaction((tx) =>
        tx
          .update(tenants)
          .set({
            biometricStoragePolicy: 'ENCRYPTED_CENTRAL_SYNC',
            centralTemplateStorageEnabled: true,
            biometricPolicyApprovedBy: approverUserId,
            biometricPolicyApprovedAt: new Date(),
          })
          .where(eq(tenants.id, tenantAId)),
      ),
    ).rejects.toThrow();

    // Cas valide : autorisation juridique référencée + approbateur + date d'approbation explicites
    await db.withPlatformTransaction((tx) =>
      tx
        .update(tenants)
        .set({
          biometricStoragePolicy: 'ENCRYPTED_CENTRAL_SYNC',
          centralTemplateStorageEnabled: true,
          biometricLegalAuthorizationRef: 'APD-RDC-AUT-2026-001',
          biometricPolicyApprovedBy: approverUserId,
          biometricPolicyApprovedAt: new Date(),
        })
        .where(eq(tenants.id, tenantAId)),
    );

    // Retour immédiat au mode protecteur DEVICE_ONLY
    await db.withPlatformTransaction((tx) =>
      tx
        .update(tenants)
        .set({
          biometricStoragePolicy: 'DEVICE_ONLY',
          centralTemplateStorageEnabled: false,
          biometricLegalAuthorizationRef: null,
          biometricPolicyApprovedBy: null,
          biometricPolicyApprovedAt: null,
        })
        .where(eq(tenants.id, tenantAId)),
    );
  });

  it('chaîne les entrées audit_logs en SHA-256, les isole par tenant et bloque tout UPDATE/DELETE par trigger SQL', async () => {
    await db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
      await db.appendAuditLog(tx, {
        tenantId: tenantAId,
        actorType: 'USER',
        actorId: approverUserId,
        action: 'SITE_CREATED',
        resourceType: 'site',
        afterState: { code: 'KIN-HQ', password: 'ne-jamais-enregistrer' },
      });
      await db.appendAuditLog(tx, {
        tenantId: tenantAId,
        actorType: 'USER',
        actorId: approverUserId,
        action: 'BIOMETRIC_POLICY_VERIFIED',
        resourceType: 'tenant',
        reason: 'Vérification conformité RDC',
        afterState: { policy: 'DEVICE_ONLY' },
      });
    });

    const verificationA = await db.verifyAuditChainScope(tenantAId);
    expect(verificationA.valid).toBe(true);
    expect(verificationA.checkedCount).toBe(2);

    // Tenant B ne voit aucune entrée d'audit de Tenant A
    const verificationB = await db.verifyAuditChainScope(tenantBId);
    expect(verificationB.valid).toBe(true);
    expect(verificationB.checkedCount).toBe(0);

    // Même le propriétaire SQL de la table ne peut ni modifier ni supprimer audit_logs
    await expect(
      db.executeRawForTestOnly(`UPDATE audit_logs SET action = 'FALSIFIED'`),
    ).rejects.toThrow(/IMMUABILITÉ VIOLÉE/);
    await expect(db.executeRawForTestOnly(`DELETE FROM audit_logs`)).rejects.toThrow(
      /IMMUABILITÉ VIOLÉE/,
    );
  });

  it('valide la migration 0002 (18 tables FORCE RLS), l’unicité atomique concurrente des matricules et les verrous SQL documents/consentements (Mission 2)', async () => {
    const ping = await db.ping();
    expect(ping.rlsTablesCount).toBe(18);

    // 8 allocations concurrentes sur Tenant A + 2 sur Tenant B -> zéro collision, séquences indépendantes
    const [allocatedA, allocatedB] = await Promise.all([
      Promise.all(
        Array.from({ length: 8 }, () =>
          db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
            db.allocateAtomicMatricule(tx, {
              tenantId: tenantAId,
              pattern: '{SITE}-{YYYY}-{SEQ:5}',
              siteCode: 'KIN-HQ',
              tenantSlug: 'alpha',
              hireDate: '2026-11-17',
            }),
          ),
        ),
      ),
      Promise.all(
        Array.from({ length: 2 }, () =>
          db.withTenantTransaction(tenantBId, approverUserId, (tx) =>
            db.allocateAtomicMatricule(tx, {
              tenantId: tenantBId,
              pattern: '{SITE}-{YYYY}-{SEQ:5}',
              siteCode: 'LUB-HQ',
              tenantSlug: 'beta',
              hireDate: '2026-11-17',
            }),
          ),
        ),
      ),
    ]);

    expect(new Set(allocatedA).size).toBe(8);
    expect([...allocatedA].sort()).toEqual([
      'KIN-HQ-2026-00001',
      'KIN-HQ-2026-00002',
      'KIN-HQ-2026-00003',
      'KIN-HQ-2026-00004',
      'KIN-HQ-2026-00005',
      'KIN-HQ-2026-00006',
      'KIN-HQ-2026-00007',
      'KIN-HQ-2026-00008',
    ]);
    expect([...allocatedB].sort()).toEqual(['LUB-HQ-2026-00001', 'LUB-HQ-2026-00002']);

    // Vérification isolation FORCE RLS sur employees + verrous SQL employee_documents & employee_consents
    const empAId = uuidv7();
    await db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
      const [siteA] = await tx.select().from(sites).limit(1);
      await tx.insert(employees).values({
        id: empAId,
        tenantId: tenantAId,
        matricule: allocatedA[0]!,
        primarySiteId: siteA!.id,
        lastName: 'MBUYI',
        postName: 'KABONGO',
        firstName: 'Aline',
        gender: 'F',
        birthDate: '1992-04-15',
        hireDate: '2026-11-17',
      });
    });

    // Tenant B ne voit aucun employé de Tenant A
    const seenByB = await db.withTenantTransaction(tenantBId, approverUserId, (tx) =>
      tx.select().from(employees),
    );
    expect(seenByB).toHaveLength(0);

    // Verrou SQL : impossible d'enregistrer une clé S3 hors du préfixe strict tenants/{tenantId}/employees/{empId}/documents/
    await expect(
      db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
        tx.insert(employeeDocuments).values({
          id: uuidv7(),
          tenantId: tenantAId,
          employeeId: empAId,
          category: 'IDENTITY_DOC',
          title: 'Pièce test',
          originalFilename: 'ceni.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 128,
          sha256Checksum: 'a'.repeat(64),
          storageBucket: 'nexus-rh-documents',
          objectKey: `tenants/${tenantBId}/employees/${empAId}/documents/fuite.pdf`,
          uploadedBy: approverUserId,
        }),
      ),
    ).rejects.toThrow();

    // Verrou SQL : impossible d'accorder BIOMETRIC_CENTRAL_TEMPLATE sans pièce écrite signée
    await expect(
      db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
        tx.insert(employeeConsents).values({
          id: uuidv7(),
          tenantId: tenantAId,
          employeeId: empAId,
          consentType: 'BIOMETRIC_CENTRAL_TEMPLATE',
          decision: 'GRANTED',
          policyVersion: '2026.1',
          collectionMethod: 'HR_ATTESTED_PAPER',
          noticeSummary: 'Notice légale RDC biométrie test',
          alternativeQrPinOffered: true,
          signedDocumentId: null,
          recordedBy: approverUserId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('applique les verrous SQL Vague 1 (G-01 âge révolu & preuve biométrique, N-01 unicité GRANTED & déduplication non destructive, B-04 immuabilité consentements & permissions, N-02 réattribution rôle révoqué)', async () => {
    const [siteA] = await db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
      tx.select().from(sites).limit(1),
    );
    expect(siteA).toBeDefined();

    // 1. G-01 SQL : rejet d'un mineur de 15 ans et 364 jours (même si hireYear - birthYear = 16)
    await expect(
      db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
        tx.insert(employees).values({
          id: uuidv7(),
          tenantId: tenantAId,
          matricule: 'KIN-V1-MINOR',
          primarySiteId: siteA!.id,
          lastName: 'LUKUSA',
          firstName: 'Marc',
          gender: 'M',
          birthDate: '2010-12-31',
          hireDate: '2026-01-02',
        }),
      ),
    ).rejects.toThrow();

    // Acceptation exacte le jour du 16e anniversaire (année bissextile 2008-02-29 -> 2024-02-29)
    const empV1Id = uuidv7();
    const docConsentId = uuidv7();
    await db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
      await tx.insert(employees).values({
        id: empV1Id,
        tenantId: tenantAId,
        matricule: 'KIN-V1-00001',
        primarySiteId: siteA!.id,
        lastName: 'TSHIMANGA',
        firstName: 'Grace',
        gender: 'F',
        birthDate: '2008-02-29',
        hireDate: '2024-02-29',
        nationalityCode: 'FR',
        identityDocType: 'PERMIS_TRAVAIL_ETRANGER',
        identityDocExpiresAt: '2028-02-28',
      });

      await tx.insert(employeeDocuments).values({
        id: docConsentId,
        tenantId: tenantAId,
        employeeId: empV1Id,
        category: 'SIGNED_CONSENT',
        title: 'Consentement biométrique signé',
        originalFilename: 'consentement.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 256,
        sha256Checksum: 'b'.repeat(64),
        storageBucket: 'nexus-rh-documents',
        objectKey: `tenants/${tenantAId}/employees/${empV1Id}/documents/consentement.pdf`,
        expiresAt: '2028-12-31',
        retentionUntil: '2033-12-31',
        uploadedBy: approverUserId,
      });
    });

    // 2. G-01 SQL : BIOMETRIC_DEVICE_ONLY GRANTED sans signed_document_id est bloqué en SQL
    await expect(
      db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
        tx.insert(employeeConsents).values({
          id: uuidv7(),
          tenantId: tenantAId,
          employeeId: empV1Id,
          consentType: 'BIOMETRIC_DEVICE_ONLY',
          decision: 'GRANTED',
          policyVersion: 'RDC-2026.1',
          collectionMethod: 'HR_ATTESTED_PAPER',
          noticeSummary: 'Notice biométrique complète remise à l’agent.',
          alternativeQrPinOffered: true,
          signedDocumentId: null,
          recordedBy: approverUserId,
        }),
      ),
    ).rejects.toThrow();

    // 3. N-01 SQL : un premier GRANTED signé passe, un second GRANTED simultané du même type échoue (23505)
    const consent1Id = uuidv7();
    await db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
      tx.insert(employeeConsents).values({
        id: consent1Id,
        tenantId: tenantAId,
        employeeId: empV1Id,
        consentType: 'BIOMETRIC_DEVICE_ONLY',
        decision: 'GRANTED',
        policyVersion: 'RDC-2026.1',
        collectionMethod: 'WRITTEN_SIGNED_UPLOAD',
        noticeSummary: 'Notice biométrique locale v1 signée.',
        alternativeQrPinOffered: true,
        signedDocumentId: docConsentId,
        recordedBy: approverUserId,
      }),
    );

    await expect(
      db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
        tx.insert(employeeConsents).values({
          id: uuidv7(),
          tenantId: tenantAId,
          employeeId: empV1Id,
          consentType: 'BIOMETRIC_DEVICE_ONLY',
          decision: 'GRANTED',
          policyVersion: 'RDC-2026.2',
          collectionMethod: 'WRITTEN_SIGNED_UPLOAD',
          noticeSummary: 'Doublon biométrique actif interdit.',
          alternativeQrPinOffered: true,
          signedDocumentId: docConsentId,
          recordedBy: approverUserId,
        }),
      ),
    ).rejects.toThrow();

    // 4. B-04 SQL : nexus_app ne peut ni modifier `permissions`, ni altérer la preuve initiale, ni supprimer un consentement
    await expect(
      db.withPlatformTransaction((tx) =>
        tx.update(permissions).set({ description: 'Altération interdite' }),
      ),
    ).rejects.toThrow();

    await expect(
      db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
        tx
          .update(employeeConsents)
          .set({
            decision: 'WITHDRAWN',
            withdrawnAt: new Date(),
            withdrawalReason: 'Retrait légitime mais tentative falsification notice',
            noticeSummary: 'Notice falsifiée',
          })
          .where(eq(employeeConsents.id, consent1Id)),
      ),
    ).rejects.toThrow();

    await expect(
      db.executeRawForTestOnly(`DELETE FROM employee_consents WHERE id = '${consent1Id}'`),
    ).rejects.toThrow(/INTÉGRITÉ CONSENTEMENT VIOLÉE/);

    // Retrait légitime GRANTED -> WITHDRAWN autorisé, puis réactivation WITHDRAWN -> GRANTED bloquée
    await db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
      tx
        .update(employeeConsents)
        .set({
          decision: 'WITHDRAWN',
          withdrawnAt: new Date(),
          withdrawnBy: approverUserId,
          withdrawalReason: 'Retrait volontaire par la salariée.',
          updatedAt: new Date(),
        })
        .where(eq(employeeConsents.id, consent1Id)),
    );

    await expect(
      db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
        tx
          .update(employeeConsents)
          .set({
            decision: 'GRANTED',
            withdrawnAt: null,
            withdrawalReason: null,
            updatedAt: new Date(),
          })
          .where(eq(employeeConsents.id, consent1Id)),
      ),
    ).rejects.toThrow();

    // Après retrait, un nouveau consentement GRANTED est autorisé et l'historique WITHDRAWN reste intact
    const consent2Id = uuidv7();
    await db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
      tx.insert(employeeConsents).values({
        id: consent2Id,
        tenantId: tenantAId,
        employeeId: empV1Id,
        consentType: 'BIOMETRIC_DEVICE_ONLY',
        decision: 'GRANTED',
        policyVersion: 'RDC-2026.2',
        collectionMethod: 'WRITTEN_SIGNED_UPLOAD',
        noticeSummary: 'Nouveau consentement biométrique signé v2.',
        alternativeQrPinOffered: true,
        signedDocumentId: docConsentId,
        recordedBy: approverUserId,
      }),
    );

    const history = await db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
      tx
        .select()
        .from(employeeConsents)
        .where(
          and(
            eq(employeeConsents.tenantId, tenantAId),
            eq(employeeConsents.employeeId, empV1Id),
          ),
        ),
    );
    expect(history).toHaveLength(2);
    expect(history.filter((c) => c.decision === 'GRANTED')).toHaveLength(1);
    expect(history.filter((c) => c.decision === 'WITHDRAWN')).toHaveLength(1);

    // 5. N-02 SQL : réattribution d'un rôle révoqué autorisée avec historique conservé, doublon ACTIVE bloqué
    const [hrRole] = await db.withPlatformTransaction((tx) =>
      tx.select().from(roles).where(eq(roles.code, 'HR_MANAGER')).limit(1),
    );
    const m1 = uuidv7();
    const m2 = uuidv7();
    await db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
      await tx.insert(tenantMemberships).values({
        id: m1,
        tenantId: tenantAId,
        userId: approverUserId,
        roleId: hrRole!.id,
        scopeType: 'ALL_SITES',
        status: 'REVOKED',
        revokedAt: new Date(),
        revokeReason: 'Fin de mission initiale',
      });
      await tx.insert(tenantMemberships).values({
        id: m2,
        tenantId: tenantAId,
        userId: approverUserId,
        roleId: hrRole!.id,
        scopeType: 'ALL_SITES',
        status: 'ACTIVE',
      });
    });

    await expect(
      db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
        tx.insert(tenantMemberships).values({
          id: uuidv7(),
          tenantId: tenantAId,
          userId: approverUserId,
          roleId: hrRole!.id,
          scopeType: 'ALL_SITES',
          status: 'ACTIVE',
        }),
      ),
    ).rejects.toThrow();

    // 6. N-01 migration sur base existante (0001 + 0002 avec doublons GRANTED préexistants -> 0003) :
    //    démontre qu'aucun consentement historique n'est supprimé lors de la mise à niveau.
    if (db.driverKind === 'pglite') {
      const legacyDb = await NexusDatabase.connect({
        profile: 'sandbox',
        pgliteDataDir: 'memory://',
      });
      try {
        const migDir = path.resolve(__dirname, '..', 'migrations');
        await legacyDb.executeRawForTestOnly(
          fs.readFileSync(path.join(migDir, '0001_mission1_foundation.sql'), 'utf8'),
        );
        await legacyDb.executeRawForTestOnly(
          fs.readFileSync(path.join(migDir, '0002_mission2_core_hr.sql'), 'utf8'),
        );

        const legTenantId = uuidv7();
        const legSiteId = uuidv7();
        const legUserId = uuidv7();
        const legEmpId = uuidv7();
        const oldDupId = uuidv7();
        const newestGrantedId = uuidv7();
        const refusedHistId = uuidv7();

        await legacyDb.executeRawForTestOnly(`
          INSERT INTO users (id, email, password_hash, full_name) VALUES ('${legUserId}', 'leg@nexus.cd', 'hash', 'Legacy RH');
          INSERT INTO tenants (id, slug, legal_name, legal_form, encryption_key_ref) VALUES ('${legTenantId}', 'leg-co', 'Legacy SARL', 'SARL', 'k1');
          INSERT INTO sites (id, tenant_id, code, name, province, city, timezone, is_headquarters) VALUES ('${legSiteId}', '${legTenantId}', 'KIN', 'Siège', 'Kinshasa', 'Kinshasa', 'Africa/Kinshasa', true);
          INSERT INTO employees (id, tenant_id, matricule, primary_site_id, last_name, first_name, gender, birth_date, hire_date)
            VALUES ('${legEmpId}', '${legTenantId}', 'LEG-001', '${legSiteId}', 'MOKE', 'Paul', 'M', '1990-01-10', '2025-01-10');
          INSERT INTO employee_consents (id, tenant_id, employee_id, consent_type, decision, policy_version, collection_method, notice_summary, alternative_qr_pin_offered, decided_at, recorded_by)
            VALUES
              ('${refusedHistId}', '${legTenantId}', '${legEmpId}', 'BIOMETRIC_DEVICE_ONLY', 'REFUSED', 'v0', 'HR_ATTESTED_PAPER', 'Refus initial conservé', true, '2025-01-10T08:00:00Z', '${legUserId}'),
              ('${oldDupId}', '${legTenantId}', '${legEmpId}', 'BIOMETRIC_DEVICE_ONLY', 'GRANTED', 'v1', 'HR_ATTESTED_PAPER', 'Ancien doublon actif sans pièce', true, '2025-06-01T08:00:00Z', '${legUserId}'),
              ('${newestGrantedId}', '${legTenantId}', '${legEmpId}', 'BIOMETRIC_DEVICE_ONLY', 'GRANTED', 'v2', 'HR_ATTESTED_PAPER', 'Consentement actif le plus récent', true, '2026-01-01T08:00:00Z', '${legUserId}');
        `);

        // Application non destructive de la migration 0003 sur ces données préexistantes
        await legacyDb.executeRawForTestOnly(
          fs.readFileSync(path.join(migDir, '0003_mission2_wave1_integrity.sql'), 'utf8'),
        );

        const afterUpgrade = await legacyDb.withTenantTransaction(legTenantId, legUserId, (tx) =>
          tx.select().from(employeeConsents),
        );
        // Zéro ligne supprimée : les 3 consentements existent toujours
        expect(afterUpgrade).toHaveLength(3);
        expect(afterUpgrade.find((r) => r.id === refusedHistId)?.decision).toBe('REFUSED');
        expect(afterUpgrade.find((r) => r.id === oldDupId)?.decision).toBe('WITHDRAWN');
        expect(afterUpgrade.find((r) => r.id === newestGrantedId)?.decision).toBe('GRANTED');
      } finally {
        await legacyDb.close();
      }
    }
  });

  it('vérifie la chaîne d’audit SHA-256 par lots bornés et relaye outbox_events avec recul exponentiel et DLQ (B-06)', async () => {
    // Ajoute plusieurs entrées d'audit sur Tenant A puis compare batchSize=2 vs batchSize=500
    await db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
      for (let i = 0; i < 5; i += 1) {
        await db.appendAuditLog(tx, {
          tenantId: tenantAId,
          actorType: 'USER',
          actorId: approverUserId,
          action: `WAVE1_PAGINATED_CHECK_${i}`,
          resourceType: 'audit_test',
          resourceId: String(i),
          afterState: { step: i },
        });
      }
    });

    const fullVerify = await db.verifyAuditChainScope(tenantAId, 500);
    const pagedVerify = await db.verifyAuditChainScope(tenantAId, 2);
    expect(pagedVerify.valid).toBe(true);
    expect(pagedVerify.checkedCount).toBeGreaterThanOrEqual(7);
    expect(pagedVerify).toEqual(fullVerify);

    // Test du relayeur transactionnel outbox_events : reprise après échec transitoire + bascule DLQ
    const transientEventId = uuidv7();
    const poisonEventId = uuidv7();
    const pastDate = new Date(Date.now() - 5_000);

    await db.withTenantTransaction(tenantAId, approverUserId, async (tx) => {
      await tx.insert(outboxEvents).values([
        {
          id: transientEventId,
          tenantId: tenantAId,
          exchange: 'nexus.employees',
          routingKey: 'employee.created',
          payload: { kind: 'transient' },
          status: 'PENDING',
          nextAttemptAt: pastDate,
        },
        {
          id: poisonEventId,
          tenantId: tenantAId,
          exchange: 'nexus.employees',
          routingKey: 'employee.poison',
          payload: { kind: 'poison' },
          status: 'PENDING',
          nextAttemptAt: pastDate,
        },
      ]);
    });

    let transientFailedOnce = false;
    const deliveredIds: string[] = [];

    // Cycle 1 : les deux échouent -> passent en FAILED (rescheduled = 2)
    const run1 = await db.relayPendingOutboxEvents(
      async (msg) => {
        if (msg.eventId === transientEventId && !transientFailedOnce) {
          transientFailedOnce = true;
          throw new Error('Coupure transitoire RabbitMQ');
        }
        if (msg.eventId === poisonEventId) {
          throw new Error('Erreur permanente courtier');
        }
        deliveredIds.push(msg.eventId);
      },
      { tenantId: tenantAId, maxAttempts: 2, baseBackoffSeconds: 1 },
    );
    expect(run1.rescheduled).toBe(2);
    expect(run1.published).toBe(0);
    expect(run1.deadLettered).toBe(0);

    // Ramène next_attempt_at à échéance pour déclencher immédiatement le cycle 2 (maxAttempts = 2)
    await db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
      tx
        .update(outboxEvents)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(sql`${outboxEvents.id} IN (${transientEventId}::uuid, ${poisonEventId}::uuid)`),
    );

    // Cycle 2 : l'événement transitoire passe en PUBLISHED, l'événement en échec répété bascule en DLQ
    const run2 = await db.relayPendingOutboxEvents(
      async (msg) => {
        if (msg.eventId === poisonEventId) {
          throw new Error('Erreur permanente courtier');
        }
        deliveredIds.push(msg.eventId);
      },
      { tenantId: tenantAId, maxAttempts: 2, baseBackoffSeconds: 1 },
    );
    expect(run2.published).toBe(1);
    expect(run2.deadLettered).toBe(1);
    expect(deliveredIds).toEqual([transientEventId]);

    const finalStates = await db.withTenantTransaction(tenantAId, approverUserId, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(sql`${outboxEvents.id} IN (${transientEventId}::uuid, ${poisonEventId}::uuid)`),
    );
    const transientRow = finalStates.find((r) => r.id === transientEventId)!;
    const poisonRow = finalStates.find((r) => r.id === poisonEventId)!;
    expect(transientRow.status).toBe('PUBLISHED');
    expect(transientRow.attemptCount).toBe(2);
    expect(transientRow.publishedAt).not.toBeNull();
    expect(transientRow.lastError).toBeNull();
    expect(poisonRow.status).toBe('DLQ');
    expect(poisonRow.attemptCount).toBe(2);
    expect(poisonRow.lastError).toContain('Erreur permanente courtier');
  });

  it('applique la migration 0004 (N-04 rétro-propagation MFA par tenant, C-04 contrainte expiration) et la politique TLS PostgreSQL (D-06)', async () => {
    // 1. D-06 : Configuration TLS explicite sur pg.Pool
    expect(buildPgSslConfig('production')).toEqual({
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    });
    expect(buildPgSslConfig('production', 'verify-full', '-----BEGIN CERTIFICATE-----\nTEST\n')).toEqual({
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n',
    });
    expect(() => buildPgSslConfig('production', 'disable')).toThrow(/interdit/);
    expect(buildPgSslConfig('docker')).toBe(false);
    expect(buildPgSslConfig('docker', 'require')).toEqual({
      minVersion: 'TLSv1.2',
      rejectUnauthorized: false,
    });
    expect(buildPgSslConfig('docker', 'verify-full')).toEqual({
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    });

    // 2. N-04 + C-04 : Rétro-propagation non destructive de 0004 sur une base pré-0004
    const migDb = await NexusDatabase.connect({ profile: 'sandbox', pgliteDataDir: 'memory://' });
    try {
      const migDir = path.resolve(__dirname, '..', 'migrations');
      for (const file of [
        '0001_mission1_foundation.sql',
        '0002_mission2_core_hr.sql',
        '0003_mission2_wave1_integrity.sql',
      ]) {
        await migDb.executeRawForTestOnly(fs.readFileSync(path.join(migDir, file), 'utf8'));
      }
      await migDb.seedSystemCatalog();

      const pwHash = await hashPassword('Wave2Migration#2026!Ok');
      const saId = uuidv7();
      const legacyAdminId = uuidv7();
      const tId = uuidv7();
      const memId = uuidv7();

      await migDb.executeRawForTestOnly(`
        INSERT INTO users (id, email, password_hash, full_name, is_platform_superadmin, mfa_required, status)
        VALUES
          ('${saId}', 'sa.mig04@nexus-test.invalid', '${pwHash.replace(/'/g, "''")}', 'SA Mig04', TRUE, TRUE, 'ACTIVE'),
          ('${legacyAdminId}', 'admin.mig04@nexus-test.invalid', '${pwHash.replace(/'/g, "''")}', 'Admin Mig04', FALSE, TRUE, 'ACTIVE');
        INSERT INTO tenants (id, slug, legal_name, legal_form, sector_code, encryption_key_ref, status)
        VALUES ('${tId}', 'mig04-tenant', 'Mig04 SARL', 'SARL', 'INDUSTRY', 'kek-mig04', 'ACTIVE');
        INSERT INTO tenant_memberships (id, tenant_id, user_id, role_id, scope_type, status)
        SELECT '${memId}', '${tId}', '${legacyAdminId}', r.id, 'ALL_SITES', 'ACTIVE'
        FROM roles r WHERE r.tenant_id IS NULL AND r.code = 'TENANT_ADMIN';
      `);

      // Application de 0004 (2 fois pour prouver l'idempotence)
      const sql0004 = fs.readFileSync(
        path.join(migDir, '0004_mission2_wave2_security.sql'),
        'utf8',
      );
      await migDb.executeRawForTestOnly(sql0004);
      await migDb.executeRawForTestOnly(sql0004);

      // Le Super-Admin conserve users.mfa_required = true ; l'admin locataire voit son obligation
      // transférée sur tenant_memberships.mfa_required = true et users.mfa_required libéré à false
      await migDb.withPlatformTransaction(async (tx) => {
        const [sa] = await tx.select().from(users).where(eq(users.id, saId));
        const [adm] = await tx.select().from(users).where(eq(users.id, legacyAdminId));
        expect(sa?.mfaRequired).toBe(true);
        expect(adm?.mfaRequired).toBe(false);
      });

      await migDb.withTenantTransaction(tId, legacyAdminId, async (tx) => {
        const [mem] = await tx
          .select()
          .from(tenantMemberships)
          .where(eq(tenantMemberships.id, memId));
        expect(mem?.mfaRequired).toBe(true);
        expect(mem?.expiresAt).toBeNull();

        // C-04 : La contrainte chk_memberships_expiry_after_created rejette toute date antérieure à created_at
        await expect(
          tx
            .update(tenantMemberships)
            .set({ expiresAt: new Date('2020-01-01T00:00:00.000Z') })
            .where(eq(tenantMemberships.id, memId)),
        ).rejects.toThrow();
      });
    } finally {
      await migDb.close();
    }
  });
});
