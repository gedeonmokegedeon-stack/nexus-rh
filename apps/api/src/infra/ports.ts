/**
 * Ports d'infrastructure hexagonaux (ARCHITECTURE_TECHNIQUE.md § 9.1).
 * Permettent de brancher Redis 7, RabbitMQ et S3 en production/Docker,
 * et des adaptateurs locaux explicites (isSandboxFallback = true) en sandbox/test.
 */

export const APP_CONFIG = Symbol('APP_CONFIG');
export const NEXUS_DB = Symbol('NEXUS_DB');
export const CACHE_LOCK_PORT = Symbol('CACHE_LOCK_PORT');
export const MESSAGE_BUS_PORT = Symbol('MESSAGE_BUS_PORT');
export const OBJECT_STORAGE_PORT = Symbol('OBJECT_STORAGE_PORT');

export interface AdapterHealth {
  readonly adapter: string;
  readonly ok: boolean;
  readonly isSandboxFallback: boolean;
  readonly detail?: string;
}

export interface CacheLockPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  incrementWithWindow(key: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
  acquireLock(lockName: string, ttlSeconds: number): Promise<string | null>;
  releaseLock(lockName: string, token: string): Promise<void>;
  health(): Promise<AdapterHealth>;
  close(): Promise<void>;
}

export interface DomainEventEnvelope {
  readonly eventId: string;
  readonly tenantId: string;
  readonly exchange: string;
  readonly routingKey: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export interface MessageBusPort {
  publish(event: DomainEventEnvelope): Promise<void>;
  health(): Promise<AdapterHealth>;
  close(): Promise<void>;
}

export interface ObjectStoragePort {
  putObject(params: {
    tenantId: string;
    objectKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<void>;
  getObject(params: { tenantId: string; objectKey: string }): Promise<Buffer>;
  deleteObject(params: { tenantId: string; objectKey: string }): Promise<void>;
  createPresignedUploadUrl(params: {
    tenantId: string;
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string>;
  createPresignedDownloadUrl(params: {
    tenantId: string;
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<string>;
  health(): Promise<AdapterHealth>;
}
