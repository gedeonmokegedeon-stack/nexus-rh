import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { uuidv7 } from '@nexus-rh/crypto-audit';
import type { AppConfig } from '../config/app-config';
import type {
  AdapterHealth,
  CacheLockPort,
  DomainEventEnvelope,
  MessageBusPort,
  ObjectStoragePort,
} from './ports';

// ============================================================================
// 1. REDIS 7 (Production / Docker) & Adaptateur mémoire (Sandbox uniquement)
// ============================================================================

// Script Lua atomique INCR + EXPIRE (D-05) :
// élimine la fenêtre de course entre INCR et EXPIRE et auto-répare toute clé sans TTL (< 0).
export const REDIS_ATOMIC_INCR_WINDOW_LUA = [
  "local current = redis.call('INCR', KEYS[1])",
  "local ttl = redis.call('TTL', KEYS[1])",
  'if current == 1 or ttl < 0 then',
  "  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))",
  '  ttl = tonumber(ARGV[1])',
  'end',
  'return { current, ttl }',
].join('\n');

export class RedisCacheLockAdapter implements CacheLockPort {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(redisUrl: string, prefix: string) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 5_000,
    });
    this.prefix = prefix;
  }

  private k(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(this.k(key));
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.k(key), value, 'EX', Math.max(1, Math.floor(ttlSeconds)));
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.k(key));
  }

  async incrementWithWindow(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> {
    const safeWindow = Math.max(1, Math.floor(windowSeconds));
    const full = this.k(key);
    const raw = (await this.redis.eval(
      REDIS_ATOMIC_INCR_WINDOW_LUA,
      1,
      full,
      String(safeWindow),
    )) as [number | string, number | string];
    const count = Number(raw[0]);
    const ttl = Number(raw[1]);
    return { count, ttlSeconds: ttl > 0 ? ttl : safeWindow };
  }

  async acquireLock(lockName: string, ttlSeconds: number): Promise<string | null> {
    const token = uuidv7();
    const res = await this.redis.set(this.k(`lock:${lockName}`), token, 'EX', ttlSeconds, 'NX');
    return res === 'OK' ? token : null;
  }

  async releaseLock(lockName: string, token: string): Promise<void> {
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await this.redis.eval(script, 1, this.k(`lock:${lockName}`), token);
  }

  async health(): Promise<AdapterHealth> {
    const pong = await this.redis.ping();
    return { adapter: 'redis-7', ok: pong === 'PONG', isSandboxFallback: false };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export class SandboxMemoryCacheLockAdapter implements CacheLockPort {
  private readonly store = new Map<string, { value: string; expiresAtMs: number }>();
  private opsSinceSweep = 0;

  private maybeSweepExpired(): void {
    this.opsSinceSweep += 1;
    if (this.opsSinceSweep < 256 && this.store.size < 4_096) {
      return;
    }
    this.opsSinceSweep = 0;
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (now >= entry.expiresAtMs) {
        this.store.delete(k);
      }
    }
  }

  private readAlive(key: string): { value: string; expiresAtMs: number } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAtMs) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.readAlive(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.maybeSweepExpired();
    const safeTtl = Math.max(1, Math.floor(ttlSeconds));
    this.store.set(key, { value, expiresAtMs: Date.now() + safeTtl * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incrementWithWindow(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> {
    this.maybeSweepExpired();
    const safeWindow = Math.max(1, Math.floor(windowSeconds));
    const existing = this.readAlive(key);
    if (!existing) {
      const expiresAtMs = Date.now() + safeWindow * 1000;
      this.store.set(key, { value: '1', expiresAtMs });
      return { count: 1, ttlSeconds: safeWindow };
    }
    const next = Number(existing.value) + 1;
    existing.value = String(next);
    return {
      count: next,
      ttlSeconds: Math.max(1, Math.ceil((existing.expiresAtMs - Date.now()) / 1000)),
    };
  }

  async acquireLock(lockName: string, ttlSeconds: number): Promise<string | null> {
    const key = `lock:${lockName}`;
    if (this.readAlive(key)) return null;
    const token = uuidv7();
    this.store.set(key, { value: token, expiresAtMs: Date.now() + ttlSeconds * 1000 });
    return token;
  }

  async releaseLock(lockName: string, token: string): Promise<void> {
    const key = `lock:${lockName}`;
    const current = this.readAlive(key);
    if (current?.value === token) {
      this.store.delete(key);
    }
  }

  async health(): Promise<AdapterHealth> {
    return {
      adapter: 'sandbox-memory-cache',
      ok: true,
      isSandboxFallback: true,
      detail: 'Adaptateur mémoire mono-instance actif (Redis 7 utilisé en Docker/Production).',
    };
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

// ============================================================================
// 2. RABBITMQ (Production / Docker) & Bus local DLQ (Sandbox uniquement)
// ============================================================================

const NEXUS_EXCHANGES = [
  'nexus.tenants',
  'nexus.employees',
  'nexus.attendance',
  'nexus.devices',
  'nexus.payroll',
  'nexus.documents',
  'nexus.notifications',
] as const;

export class RabbitMqBusAdapter implements MessageBusPort {
  private constructor(
    private readonly conn: ChannelModel,
    private readonly channel: ConfirmChannel,
  ) {}

  static async connect(rabbitmqUrl: string): Promise<RabbitMqBusAdapter> {
    const conn = await amqp.connect(rabbitmqUrl);
    const channel = await conn.createConfirmChannel();
    await channel.assertExchange('nexus.dlx', 'topic', { durable: true });
    for (const ex of NEXUS_EXCHANGES) {
      await channel.assertExchange(ex, 'topic', { durable: true });
    }
    return new RabbitMqBusAdapter(conn, channel);
  }

  async publish(event: DomainEventEnvelope): Promise<void> {
    const payload = Buffer.from(JSON.stringify(event), 'utf8');
    await new Promise<void>((resolve, reject) => {
      this.channel.publish(
        event.exchange,
        event.routingKey,
        payload,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: event.eventId,
          timestamp: Date.now(),
          headers: { 'x-tenant-id': event.tenantId },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  async health(): Promise<AdapterHealth> {
    return { adapter: 'rabbitmq-amqp', ok: true, isSandboxFallback: false };
  }

  async close(): Promise<void> {
    await this.channel.close();
    await this.conn.close();
  }
}

export class SandboxMessageBusAdapter implements MessageBusPort {
  private publishedCount = 0;
  private readonly dlq: DomainEventEnvelope[] = [];

  async publish(event: DomainEventEnvelope): Promise<void> {
    if (!event.eventId || !event.tenantId) {
      this.dlq.push(event);
      throw new Error('Enveloppe de message invalide envoyée en DLQ.');
    }
    this.publishedCount += 1;
  }

  async health(): Promise<AdapterHealth> {
    return {
      adapter: 'sandbox-inprocess-bus',
      ok: true,
      isSandboxFallback: true,
      detail: `Bus local actif (${this.publishedCount} événement(s), DLQ=${this.dlq.length} ; RabbitMQ utilisé en Docker/Production).`,
    };
  }

  async close(): Promise<void> {
    // Rien à fermer
  }
}

// ============================================================================
// 3. STOCKAGE COMPATIBLE S3 (Production / Docker) & Local signé (Sandbox)
// ============================================================================

function assertTenantPrefixedKey(tenantId: string, objectKey: string): void {
  const expectedPrefix = `tenants/${tenantId}/`;
  if (
    !objectKey.startsWith(expectedPrefix) ||
    objectKey.includes('..') ||
    objectKey.includes('\\') ||
    objectKey.includes('\0')
  ) {
    throw new Error('Clé S3 rejetée : préfixe d’isolation tenant obligatoire.');
  }
}

export class S3ObjectStorageAdapter implements ObjectStoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: AppConfig['s3']) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
    });
  }

  async putObject(params: {
    tenantId: string;
    objectKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<void> {
    assertTenantPrefixedKey(params.tenantId, params.objectKey);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.objectKey,
        Body: params.body,
        ContentType: params.contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async getObject(params: { tenantId: string; objectKey: string }): Promise<Buffer> {
    assertTenantPrefixedKey(params.tenantId, params.objectKey);
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: params.objectKey }),
    );
    if (!out.Body) {
      throw new Error('Objet S3 introuvable ou vide.');
    }
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async deleteObject(params: { tenantId: string; objectKey: string }): Promise<void> {
    assertTenantPrefixedKey(params.tenantId, params.objectKey);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: params.objectKey }),
    );
  }

  async createPresignedUploadUrl(params: {
    tenantId: string;
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    assertTenantPrefixedKey(params.tenantId, params.objectKey);
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.objectKey,
      ContentType: params.contentType,
      ServerSideEncryption: 'AES256',
    });
    return getSignedUrl(this.client, cmd, {
      expiresIn: Math.min(300, Math.max(30, params.expiresInSeconds)),
    });
  }

  async createPresignedDownloadUrl(params: {
    tenantId: string;
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<string> {
    assertTenantPrefixedKey(params.tenantId, params.objectKey);
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: params.objectKey });
    return getSignedUrl(this.client, cmd, {
      expiresIn: Math.min(300, Math.max(30, params.expiresInSeconds)),
    });
  }

  async health(): Promise<AdapterHealth> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return { adapter: 's3-compatible', ok: true, isSandboxFallback: false };
  }
}

export class SandboxObjectStorageAdapter implements ObjectStoragePort {
  private readonly resolvedRoot: string;

  constructor(
    private readonly rootDir: string,
    private readonly signingKey: Buffer,
  ) {
    this.resolvedRoot = path.resolve(this.rootDir);
    fs.mkdirSync(this.resolvedRoot, { recursive: true });
  }

  private resolveSafeTenantFile(tenantId: string, objectKey: string): string {
    assertTenantPrefixedKey(tenantId, objectKey);
    const target = path.resolve(this.resolvedRoot, objectKey);
    const requiredRoot = `${this.resolvedRoot}${path.sep}`;
    if (!target.startsWith(requiredRoot)) {
      throw new Error('Traversée de chemin S3/local bloquée.');
    }
    return target;
  }

  async putObject(params: {
    tenantId: string;
    objectKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<void> {
    const filePath = this.resolveSafeTenantFile(params.tenantId, params.objectKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, params.body, { mode: 0o600 });
  }

  async getObject(params: { tenantId: string; objectKey: string }): Promise<Buffer> {
    const filePath = this.resolveSafeTenantFile(params.tenantId, params.objectKey);
    if (!fs.existsSync(filePath)) {
      throw new Error('Objet introuvable dans le coffre documentaire.');
    }
    return fs.readFileSync(filePath);
  }

  async deleteObject(params: { tenantId: string; objectKey: string }): Promise<void> {
    const filePath = this.resolveSafeTenantFile(params.tenantId, params.objectKey);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  private signUrl(method: 'PUT' | 'GET', objectKey: string, expiresInSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + Math.min(300, Math.max(30, expiresInSeconds));
    const sig = crypto
      .createHmac('sha256', this.signingKey)
      .update(`${method}:${objectKey}:${exp}`)
      .digest('hex');
    return `/api/v1/storage/sandbox/${encodeURIComponent(objectKey)}?exp=${exp}&sig=${sig}`;
  }

  async createPresignedUploadUrl(params: {
    tenantId: string;
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    assertTenantPrefixedKey(params.tenantId, params.objectKey);
    return this.signUrl('PUT', params.objectKey, params.expiresInSeconds);
  }

  async createPresignedDownloadUrl(params: {
    tenantId: string;
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<string> {
    assertTenantPrefixedKey(params.tenantId, params.objectKey);
    return this.signUrl('GET', params.objectKey, params.expiresInSeconds);
  }

  async health(): Promise<AdapterHealth> {
    return {
      adapter: 'sandbox-signed-fs',
      ok: true,
      isSandboxFallback: true,
      detail: 'Stockage local signé par tenant actif (API S3 utilisée en Docker/Production).',
    };
  }
}
