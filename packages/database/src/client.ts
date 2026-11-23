import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import {
  AUDIT_GENESIS_HASH,
  computeAuditEntryHash,
  redactSensitiveFields,
  sha256Hex,
  uuidv7,
  verifyAuditChain,
  type AuditChainVerificationResult,
} from '@nexus-rh/crypto-audit';
import { PERMISSION_CATALOG, SYSTEM_ROLES, type InfraProfile } from '@nexus-rh/shared-types';
import * as schema from './schema';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DrizzleDb = ReturnType<typeof drizzlePg<typeof schema>>;
export type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';

export interface CreateDatabaseOptions {
  readonly profile: InfraProfile;
  readonly connectionString?: string;
  readonly sslMode?: DatabaseSslMode;
  readonly sslCaCert?: string;
  readonly pgliteDataDir?: string; // 'memory://' pour les tests automatisés, chemin disque en sandbox
}

/**
 * Construit la configuration TLS explicite pour `pg.Pool` (D-06 / SECURITY_POLICY.md § 4.1) :
 * - En profil `production` : défaut `verify-full` (TLS >= 1.2 + vérification stricte du certificat serveur) ;
 *   le mode `disable` est formellement refusé.
 * - En profil `docker` : défaut `disable` pour le réseau local Docker Compose, activable en `require` ou `verify-full`.
 */
export function buildPgSslConfig(
  profile: InfraProfile,
  sslMode?: DatabaseSslMode,
  sslCaCert?: string,
): false | TlsConnectionOptions {
  const effectiveMode: DatabaseSslMode =
    sslMode ?? (profile === 'production' ? 'verify-full' : 'disable');

  if (profile === 'production' && effectiveMode === 'disable') {
    throw new Error(
      'SÉCURITÉ : DATABASE_SSL="disable" est interdit lorsque INFRA_PROFILE="production" (utiliser "verify-full").',
    );
  }

  if (effectiveMode === 'disable') {
    return false;
  }

  const tlsOptions: TlsConnectionOptions = {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: effectiveMode === 'verify-full',
  };
  if (sslCaCert && sslCaCert.trim().length > 0) {
    tlsOptions.ca = sslCaCert;
  }
  return tlsOptions;
}

export interface AppendAuditParams {
  readonly tenantId: string | null;
  readonly actorType: 'USER' | 'SYSTEM' | 'API_KEY' | 'DEVICE' | 'SUPERADMIN';
  readonly actorId?: string | null;
  readonly actorEmail?: string | null;
  readonly actorRole?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly siteId?: string | null;
  readonly reason?: string | null;
  readonly beforeState?: unknown;
  readonly afterState?: unknown;
}

export interface AppliedMigrationInfo {
  readonly filename: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface OutboxRelayMessage {
  readonly eventId: string;
  readonly tenantId: string;
  readonly exchange: string;
  readonly routingKey: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

export interface OutboxRelayOptions {
  readonly tenantId?: string;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly baseBackoffSeconds?: number;
}

export interface OutboxRelayResult {
  readonly scanned: number;
  readonly published: number;
  readonly rescheduled: number;
  readonly deadLettered: number;
}

const DEFAULT_AUDIT_VERIFY_BATCH_SIZE = 500;
const DEFAULT_OUTBOX_BATCH_SIZE = 50;
const DEFAULT_OUTBOX_MAX_ATTEMPTS = 8;
const DEFAULT_OUTBOX_BASE_BACKOFF_SECONDS = 5;
const MAX_OUTBOX_BACKOFF_SECONDS = 3_600;

function computeOutboxBackoffSeconds(nextAttemptCount: number, baseSeconds: number): number {
  const exp = Math.min(12, Math.max(0, nextAttemptCount - 1));
  return Math.min(MAX_OUTBOX_BACKOFF_SECONDS, Math.max(1, baseSeconds) * 2 ** exp);
}

function sanitizeOutboxError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Erreur de publication inconnue');
  return raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500) || 'Erreur de publication inconnue';
}

export class NexusDatabase {
  public readonly driverKind: 'node-postgres' | 'pglite';
  private readonly db: DrizzleDb;
  private readonly rawExec: (sqlText: string) => Promise<void>;
  private readonly closeFn: () => Promise<void>;

  private constructor(params: {
    driverKind: 'node-postgres' | 'pglite';
    db: DrizzleDb;
    rawExec: (sqlText: string) => Promise<void>;
    closeFn: () => Promise<void>;
  }) {
    this.driverKind = params.driverKind;
    this.db = params.db;
    this.rawExec = params.rawExec;
    this.closeFn = params.closeFn;
  }

  public static async connect(options: CreateDatabaseOptions): Promise<NexusDatabase> {
    if (options.profile === 'production' || options.profile === 'docker') {
      if (!options.connectionString) {
        throw new Error(
          `DATABASE_URL est obligatoire lorsque INFRA_PROFILE="${options.profile}".`,
        );
      }
      const ssl = buildPgSslConfig(options.profile, options.sslMode, options.sslCaCert);
      const pool = new Pool({
        connectionString: options.connectionString,
        max: 20,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        ssl,
      });
      // Vérification immédiate de la connectivité
      const client = await pool.connect();
      client.release();

      const db = drizzlePg(pool, { schema });
      return new NexusDatabase({
        driverKind: 'node-postgres',
        db,
        rawExec: async (sqlText: string) => {
          await pool.query(sqlText);
        },
        closeFn: async () => {
          await pool.end();
        },
      });
    }

    // Profil 'sandbox' uniquement (interdit en production)
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SÉCURITÉ : le pilote PGlite (sandbox) est formellement interdit lorsque NODE_ENV=production.',
      );
    }

    const dataDir = options.pgliteDataDir ?? 'memory://';
    if (dataDir !== 'memory://') {
      fs.mkdirSync(path.dirname(path.resolve(dataDir)), { recursive: true });
    }
    const pglite = dataDir === 'memory://' ? await PGlite.create() : await PGlite.create(dataDir);
    const db = drizzlePglite(pglite, { schema }) as unknown as DrizzleDb;

    return new NexusDatabase({
      driverKind: 'pglite',
      db,
      rawExec: async (sqlText: string) => {
        await pglite.exec(sqlText);
      },
      closeFn: async () => {
        await pglite.close();
      },
    });
  }

  /**
   * Exécute une transaction strictement isolée au sein d'un Tenant via PostgreSQL RLS :
   * 1. Bascule sur le rôle non-privilégié `nexus_app` (NOSUPERUSER, NOBYPASSRLS).
   * 2. Verrouille `app.current_tenant_id` pour toute la durée de la transaction (`SET LOCAL`).
   * 3. Désactive `app.platform_context`.
   * Même une requête SQL oubliant `WHERE tenant_id = ...` ne peut lire ni écrire un autre tenant.
   */
  public async withTenantTransaction<T>(
    tenantId: string,
    userId: string | null,
    fn: (tx: DrizzleTx) => Promise<T>,
  ): Promise<T> {
    if (!UUID_REGEX.test(tenantId)) {
      throw new Error('Contexte tenant invalide : UUID attendu.');
    }
    if (userId !== null && !UUID_REGEX.test(userId)) {
      throw new Error('Contexte utilisateur invalide : UUID attendu.');
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql.raw('SET LOCAL ROLE nexus_app'));
      await tx.execute(sql`SELECT set_config('app.platform_context', 'false', true)`);
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId ?? ''}, true)`);
      return fn(tx);
    });
  }

  /**
   * Exécute une transaction en contexte Plateforme (authentification initiale,
   * console Super-Admin, lecture des permissions système), toujours sous le rôle `nexus_app`.
   */
  public async withPlatformTransaction<T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql.raw('SET LOCAL ROLE nexus_app'));
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', '', true)`);
      await tx.execute(sql`SELECT set_config('app.platform_context', 'true', true)`);
      return fn(tx);
    });
  }

  /**
   * Ajoute une entrée immuable chaînée SHA-256 dans `audit_logs` à l'intérieur d'une transaction.
   * Prend un verrou transactionnel PostgreSQL (`pg_advisory_xact_lock`) sur la portée de chaîne
   * pour garantir une séquence linéaire sans course concurrente.
   */
  public async appendAuditLog(tx: DrizzleTx, params: AppendAuditParams): Promise<string> {
    const chainScope = params.tenantId ?? 'PLATFORM';
    if (params.tenantId !== null && !UUID_REGEX.test(params.tenantId)) {
      throw new Error('tenantId invalide pour le journal d’audit.');
    }

    // Sérialisation atomique 64 bits par chaîne (tenant ou PLATFORM) via hashtextextended
    // (évite les collisions d'anniversaire 32 bits de hashtext entre tenants distincts)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit:${chainScope}`}, 0))`,
    );

    const lastRows = await tx.execute<{ entry_hash: string }>(sql`
      SELECT entry_hash
      FROM audit_logs
      WHERE chain_scope = ${chainScope}
      ORDER BY seq_no DESC
      LIMIT 1
    `);

    const rowsArray = extractRows<{ entry_hash: string }>(lastRows);
    const prevHash = rowsArray[0]?.entry_hash ?? AUDIT_GENESIS_HASH;

    const id = uuidv7();
    const occurredAt = new Date();
    const occurredAtIso = occurredAt.toISOString();
    const sanitizedBefore =
      params.beforeState !== undefined ? redactSensitiveFields(params.beforeState) : null;
    const sanitizedAfter =
      params.afterState !== undefined ? redactSensitiveFields(params.afterState) : null;

    // Normalisation aller-retour JSON pour correspondance exacte avec JSONB PostgreSQL
    const normalizedBefore =
      sanitizedBefore !== null ? (JSON.parse(JSON.stringify(sanitizedBefore)) as unknown) : null;
    const normalizedAfter =
      sanitizedAfter !== null ? (JSON.parse(JSON.stringify(sanitizedAfter)) as unknown) : null;

    const entryHash = computeAuditEntryHash({
      id,
      chainScope,
      actorType: params.actorType,
      actorId: params.actorId ?? null,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId ?? null,
      reason: params.reason ?? null,
      beforeState: normalizedBefore,
      afterState: normalizedAfter,
      occurredAtIso,
      prevHash,
    });

    await tx.insert(schema.auditLogs).values({
      id,
      tenantId: params.tenantId,
      chainScope,
      actorType: params.actorType,
      actorId: params.actorId ?? null,
      actorEmail: params.actorEmail ?? null,
      actorRole: params.actorRole ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ? params.userAgent.slice(0, 512) : null,
      requestId: params.requestId ?? null,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId ?? null,
      siteId: params.siteId ?? null,
      reason: params.reason ?? null,
      beforeState: normalizedBefore,
      afterState: normalizedAfter,
      prevHash,
      entryHash,
      occurredAt,
    });

    return id;
  }

  /**
   * Alloue de manière strictement atomique (verrou de ligne PostgreSQL INSERT ... ON CONFLICT
   * DO UPDATE RETURNING) le prochain matricule unique d'un employé au sein du tenant actif.
   * Si la transaction échoue, le compteur est annulé proprement avec la transaction.
   */
  public async allocateAtomicMatricule(
    tx: DrizzleTx,
    params: {
      readonly tenantId: string;
      readonly pattern: string;
      readonly siteCode: string;
      readonly tenantSlug: string;
      readonly hireDate: string; // AAAA-MM-JJ
    },
  ): Promise<string> {
    if (!UUID_REGEX.test(params.tenantId)) {
      throw new Error('tenantId invalide pour l’allocation atomique de matricule.');
    }

    const yyyy = params.hireDate.slice(0, 4);
    const yy = yyyy.slice(2, 4);
    const mm = params.hireDate.slice(5, 7);
    const cleanSite = params.siteCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const cleanTenant = params.tenantSlug
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);

    // Le compteur est segmenté selon les variables présentes dans le modèle de l'entreprise
    const scopeParts = ['EMP'];
    if (params.pattern.includes('{SITE}')) scopeParts.push(`S:${cleanSite}`);
    if (params.pattern.includes('{YYYY}') || params.pattern.includes('{YY}')) {
      scopeParts.push(`Y:${yyyy}`);
    }
    if (params.pattern.includes('{MM}')) scopeParts.push(`M:${mm}`);
    const scopeKey = scopeParts.join('|').slice(0, 96);

    const res = await tx.execute<{ last_value: string | number }>(sql`
      INSERT INTO matricule_counters (tenant_id, scope_key, last_value, updated_at)
      VALUES (${params.tenantId}::uuid, ${scopeKey}, 1, NOW())
      ON CONFLICT (tenant_id, scope_key)
      DO UPDATE SET
        last_value = matricule_counters.last_value + 1,
        updated_at = NOW()
      RETURNING last_value
    `);

    const row = extractRows<{ last_value: string | number }>(res)[0];
    const seqValue = Number(row?.last_value ?? 0);
    if (!Number.isInteger(seqValue) || seqValue <= 0) {
      throw new Error('Échec de l’allocation atomique du compteur de matricule.');
    }

    const rendered = params.pattern
      .replace(/\{TENANT\}/g, cleanTenant)
      .replace(/\{SITE\}/g, cleanSite)
      .replace(/\{YYYY\}/g, yyyy)
      .replace(/\{YY\}/g, yy)
      .replace(/\{MM\}/g, mm)
      .replace(/\{SEQ:(\d+)\}/g, (_m, digitsRaw: string) => {
        const digits = Math.min(10, Math.max(2, Number(digitsRaw) || 5));
        return String(seqValue).padStart(digits, '0');
      });

    return rendered.slice(0, 80);
  }

  /**
   * Recalcule et vérifie l'intégralité de la chaîne cryptographique SHA-256 d'un tenant
   * ou de la plateforme par lots paginés sur curseur `seq_no` (mémoire bornée O(batchSize),
   * sans jamais charger toute la table `audit_logs` en RAM).
   */
  public async verifyAuditChainScope(
    tenantId: string | null,
    batchSize: number = DEFAULT_AUDIT_VERIFY_BATCH_SIZE,
  ): Promise<AuditChainVerificationResult> {
    const chainScope = tenantId ?? 'PLATFORM';
    const safeBatchSize = Math.min(2_000, Math.max(1, Math.trunc(batchSize)));

    const runQuery = async (tx: DrizzleTx): Promise<AuditChainVerificationResult> => {
      let lastSeqNo = 0;
      let rollingHeadHash = AUDIT_GENESIS_HASH;
      let totalChecked = 0;

      while (true) {
        const rows = await tx
          .select()
          .from(schema.auditLogs)
          .where(
            sql`${schema.auditLogs.chainScope} = ${chainScope} AND ${schema.auditLogs.seqNo} > ${lastSeqNo}`,
          )
          .orderBy(schema.auditLogs.seqNo)
          .limit(safeBatchSize);

        if (rows.length === 0) {
          break;
        }

        const batchResult = verifyAuditChain(
          rows.map((r) => ({
            id: r.id,
            seqNo: r.seqNo,
            chainScope: r.chainScope,
            actorType: r.actorType,
            actorId: r.actorId,
            action: r.action,
            resourceType: r.resourceType,
            resourceId: r.resourceId,
            reason: r.reason,
            beforeState: r.beforeState,
            afterState: r.afterState,
            occurredAtIso: r.occurredAt.toISOString(),
            prevHash: r.prevHash,
            entryHash: r.entryHash,
          })),
          rollingHeadHash,
        );

        if (!batchResult.valid) {
          return {
            valid: false,
            checkedCount: totalChecked + batchResult.checkedCount,
            headHash: batchResult.headHash,
            brokenAtId: batchResult.brokenAtId,
            brokenAtSeqNo: batchResult.brokenAtSeqNo,
            failureReason: batchResult.failureReason,
          };
        }

        totalChecked += batchResult.checkedCount;
        rollingHeadHash = batchResult.headHash;
        lastSeqNo = Number(rows[rows.length - 1]!.seqNo);

        if (rows.length < safeBatchSize) {
          break;
        }
      }

      return {
        valid: true,
        checkedCount: totalChecked,
        headHash: rollingHeadHash,
        brokenAtId: null,
        brokenAtSeqNo: null,
        failureReason: null,
      };
    };

    // Lecture cohérente sur instantané REPEATABLE READ READ ONLY (ouvert dès BEGIN, avant set_config)
    const txConfig = {
      isolationLevel: 'repeatable read' as const,
      accessMode: 'read only' as const,
    };

    if (tenantId) {
      if (!UUID_REGEX.test(tenantId)) {
        throw new Error('Contexte tenant invalide : UUID attendu.');
      }
      return this.db.transaction(async (tx) => {
        await tx.execute(sql.raw('SET LOCAL ROLE nexus_app'));
        await tx.execute(sql`SELECT set_config('app.platform_context', 'false', true)`);
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
        await tx.execute(sql`SELECT set_config('app.current_user_id', '', true)`);
        return runQuery(tx);
      }, txConfig);
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql.raw('SET LOCAL ROLE nexus_app'));
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', '', true)`);
      await tx.execute(sql`SELECT set_config('app.platform_context', 'true', true)`);
      return runQuery(tx);
    }, txConfig);
  }

  /**
   * Enregistre proprement l'échec d'une tentative de publication d'un événement outbox
   * (incrément `attempt_count`, recul exponentiel `next_attempt_at` et bascule `DLQ` au plafond),
   * dans le strict respect de la RLS du tenant concerné.
   */
  public async recordOutboxPublishFailure(params: {
    readonly tenantId: string;
    readonly outboxId: string;
    readonly error: unknown;
    readonly maxAttempts?: number;
    readonly baseBackoffSeconds?: number;
  }): Promise<'FAILED' | 'DLQ' | 'NOT_FOUND'> {
    const maxAttempts = Math.max(1, params.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS);
    const baseBackoff = params.baseBackoffSeconds ?? DEFAULT_OUTBOX_BASE_BACKOFF_SECONDS;
    const errorMsg = sanitizeOutboxError(params.error);

    return this.withTenantTransaction(params.tenantId, null, async (tx) => {
      const [existing] = await tx
        .select({
          id: schema.outboxEvents.id,
          status: schema.outboxEvents.status,
          attemptCount: schema.outboxEvents.attemptCount,
        })
        .from(schema.outboxEvents)
        .where(sql`${schema.outboxEvents.id} = ${params.outboxId}::uuid`)
        .limit(1);

      if (!existing || existing.status === 'PUBLISHED' || existing.status === 'DLQ') {
        return 'NOT_FOUND';
      }

      const nextAttempts = Number(existing.attemptCount) + 1;
      const nextStatus: 'FAILED' | 'DLQ' = nextAttempts >= maxAttempts ? 'DLQ' : 'FAILED';
      const delaySeconds = computeOutboxBackoffSeconds(nextAttempts, baseBackoff);
      const nextAttemptAt = new Date(Date.now() + delaySeconds * 1_000);

      await tx
        .update(schema.outboxEvents)
        .set({
          status: nextStatus,
          attemptCount: nextAttempts,
          nextAttemptAt,
          lastError: errorMsg,
        })
        .where(sql`${schema.outboxEvents.id} = ${params.outboxId}::uuid`);

      return nextStatus;
    });
  }

  /**
   * Relaye par lot borné les événements `outbox_events` en attente (`PENDING` ou `FAILED`
   * arrivés à échéance `next_attempt_at <= NOW()`), avec verrou `FOR UPDATE SKIP LOCKED`
   * contre les doubles traitements concurrents, isolation RLS par tenant et bascule `DLQ`.
   */
  public async relayPendingOutboxEvents(
    publishFn: (event: OutboxRelayMessage) => Promise<void>,
    options: OutboxRelayOptions = {},
  ): Promise<OutboxRelayResult> {
    const batchSize = Math.min(200, Math.max(1, options.batchSize ?? DEFAULT_OUTBOX_BATCH_SIZE));
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS);
    const baseBackoff = options.baseBackoffSeconds ?? DEFAULT_OUTBOX_BASE_BACKOFF_SECONDS;

    const targetTenantIds: string[] = options.tenantId
      ? [options.tenantId]
      : await this.withPlatformTransaction(async (tx) => {
          const dueTenants = await tx.execute<{ tenant_id: string }>(sql`
            SELECT DISTINCT tenant_id::text AS tenant_id
            FROM outbox_events
            WHERE status IN ('PENDING', 'FAILED')
              AND next_attempt_at <= NOW()
            LIMIT 50
          `);
          return extractRows<{ tenant_id: string }>(dueTenants).map((r) => r.tenant_id);
        });

    let scanned = 0;
    let published = 0;
    let rescheduled = 0;
    let deadLettered = 0;
    let remainingBudget = batchSize;

    for (const tenantId of targetTenantIds) {
      if (remainingBudget <= 0) break;

      await this.withTenantTransaction(tenantId, null, async (tx) => {
        const claimed = await tx.execute<{
          id: string;
          tenant_id: string;
          exchange: string;
          routing_key: string;
          payload: Record<string, unknown>;
          headers: Record<string, string>;
          attempt_count: number;
          created_at: string | Date;
        }>(sql`
          SELECT id, tenant_id, exchange, routing_key, payload, headers, attempt_count, created_at
          FROM outbox_events
          WHERE tenant_id = ${tenantId}::uuid
            AND status IN ('PENDING', 'FAILED')
            AND next_attempt_at <= NOW()
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT ${remainingBudget}
          FOR UPDATE SKIP LOCKED
        `);

        const rows = extractRows<{
          id: string;
          tenant_id: string;
          exchange: string;
          routing_key: string;
          payload: Record<string, unknown>;
          headers: Record<string, string>;
          attempt_count: number;
          created_at: string | Date;
        }>(claimed);

        for (const row of rows) {
          scanned += 1;
          remainingBudget -= 1;
          const nextAttempts = Number(row.attempt_count) + 1;
          const occurredAt =
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : new Date(row.created_at).toISOString();

          try {
            await publishFn({
              eventId: row.id,
              tenantId: row.tenant_id,
              exchange: row.exchange,
              routingKey: row.routing_key,
              occurredAt,
              payload: row.payload ?? {},
              headers: row.headers ?? {},
            });

            await tx
              .update(schema.outboxEvents)
              .set({
                status: 'PUBLISHED',
                attemptCount: nextAttempts,
                publishedAt: new Date(),
                lastError: null,
              })
              .where(sql`${schema.outboxEvents.id} = ${row.id}::uuid`);
            published += 1;
          } catch (err) {
            const isDlq = nextAttempts >= maxAttempts;
            const nextStatus: 'FAILED' | 'DLQ' = isDlq ? 'DLQ' : 'FAILED';
            const delaySeconds = computeOutboxBackoffSeconds(nextAttempts, baseBackoff);
            const nextAttemptAt = new Date(Date.now() + delaySeconds * 1_000);

            await tx
              .update(schema.outboxEvents)
              .set({
                status: nextStatus,
                attemptCount: nextAttempts,
                nextAttemptAt,
                lastError: sanitizeOutboxError(err),
              })
              .where(sql`${schema.outboxEvents.id} = ${row.id}::uuid`);

            if (isDlq) {
              deadLettered += 1;
            } else {
              rescheduled += 1;
            }
          }
        }
      });
    }

    return { scanned, published, rescheduled, deadLettered };
  }

  /**
   * Applique de manière idempotente et vérifiée (SHA-256) les migrations SQL versionnées.
   */
  public async runMigrations(customMigrationsDir?: string): Promise<AppliedMigrationInfo[]> {
    const migrationsDir =
      customMigrationsDir ?? path.resolve(__dirname, '..', 'migrations');

    await this.rawExec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const appliedResult = await this.db.execute<{
      filename: string;
      checksum: string;
      applied_at: string;
    }>(sql`SELECT filename, checksum, applied_at::text FROM schema_migrations ORDER BY filename ASC`);

    const existingMap = new Map(
      extractRows<{ filename: string; checksum: string; applied_at: string }>(appliedResult).map(
        (r) => [r.filename, r],
      ),
    );

    const applied: AppliedMigrationInfo[] = [];

    for (const filename of files) {
      const content = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
      const checksum = sha256Hex(content);
      const prev = existingMap.get(filename);

      if (prev) {
        if (prev.checksum !== checksum) {
          throw new Error(
            `INTÉGRITÉ MIGRATION VIOLÉE : ${filename} a été modifiée après application (attendu ${prev.checksum}, trouvé ${checksum}).`,
          );
        }
        applied.push({ filename, checksum, appliedAt: prev.applied_at });
        continue;
      }

      await this.rawExec(`BEGIN;\n${content}\nCOMMIT;`);
      await this.db.execute(
        sql`INSERT INTO schema_migrations (filename, checksum) VALUES (${filename}, ${checksum})`,
      );
      applied.push({ filename, checksum, appliedAt: new Date().toISOString() });
    }

    return applied;
  }

  /**
   * Initialise de façon idempotente UNIQUEMENT les métadonnées techniques du système
   * (catalogue des permissions et rôles standards). N'insère AUCUNE entreprise fictive,
   * AUCUN agent fictif, AUCUN taux fiscal/social codé en dur.
   */
  public async seedSystemCatalog(): Promise<{ permissionsCount: number; systemRolesCount: number }> {
    return this.withPlatformTransaction(async (tx) => {
      const permIdByCode = new Map<string, string>();

      for (const perm of PERMISSION_CATALOG) {
        const existing = await tx
          .select()
          .from(schema.permissions)
          .where(sql`${schema.permissions.code} = ${perm.code}`)
          .limit(1);

        if (existing[0]) {
          permIdByCode.set(perm.code, existing[0].id);
        } else {
          const id = uuidv7();
          await tx.insert(schema.permissions).values({
            id,
            code: perm.code,
            module: perm.module,
            description: perm.description,
            isSensitive: perm.isSensitive,
          });
          permIdByCode.set(perm.code, id);
        }
      }

      for (const roleDef of SYSTEM_ROLES) {
        const existingRole = await tx
          .select()
          .from(schema.roles)
          .where(
            sql`${schema.roles.tenantId} IS NULL AND ${schema.roles.code} = ${roleDef.code}`,
          )
          .limit(1);

        let roleId: string;
        if (existingRole[0]) {
          roleId = existingRole[0].id;
        } else {
          roleId = uuidv7();
          await tx.insert(schema.roles).values({
            id: roleId,
            tenantId: null,
            code: roleDef.code,
            name: roleDef.name,
            description: roleDef.description,
            isSystem: true,
          });
        }

        // Synchronisation idempotente des permissions du rôle système
        await tx
          .delete(schema.rolePermissions)
          .where(sql`${schema.rolePermissions.roleId} = ${roleId}`);

        for (const permCode of roleDef.permissions) {
          const permId = permIdByCode.get(permCode);
          if (permId) {
            await tx.insert(schema.rolePermissions).values({
              roleId,
              permissionId: permId,
            });
          }
        }
      }

      return {
        permissionsCount: PERMISSION_CATALOG.length,
        systemRolesCount: SYSTEM_ROLES.length,
      };
    });
  }

  public async ping(): Promise<{ ok: boolean; pgVersion: string; rlsTablesCount: number }> {
    const res = await this.db.execute<{ version: string; rls_count: string }>(sql`
      SELECT
        current_setting('server_version') AS version,
        (
          SELECT count(*)::text
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true AND c.relforcerowsecurity = true
        ) AS rls_count
    `);
    const row = extractRows<{ version: string; rls_count: string }>(res)[0];
    return {
      ok: true,
      pgVersion: row?.version ?? 'unknown',
      rlsTablesCount: Number(row?.rls_count ?? 0),
    };
  }

  /**
   * Utilisé exclusivement dans les tests d'intrusion pour vérifier que le trigger
   * d'immuabilité bloque même le propriétaire de table.
   */
  public async executeRawForTestOnly(sqlText: string): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('executeRawForTestOnly est strictement réservé à NODE_ENV=test.');
    }
    await this.rawExec(sqlText);
  }

  public async close(): Promise<void> {
    await this.closeFn();
  }
}

export function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Détecte proprement une violation d'unicité PostgreSQL (SQLSTATE `23505`), y compris
 * lorsqu'elle est encapsulée dans `error.cause` par Drizzle ORM (`pg` ou `PGlite`).
 */
export function isPgUniqueViolation(error: unknown, constraintName?: string): boolean {
  const candidates: unknown[] = [error];
  if (error && typeof error === 'object' && 'cause' in error) {
    candidates.push((error as { cause?: unknown }).cause);
  }
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { code?: unknown; constraint?: unknown; message?: unknown };
    if (rec.code === '23505') {
      if (!constraintName) return true;
      if (rec.constraint === constraintName) return true;
      if (typeof rec.message === 'string' && rec.message.includes(constraintName)) return true;
    }
  }
  return false;
}
