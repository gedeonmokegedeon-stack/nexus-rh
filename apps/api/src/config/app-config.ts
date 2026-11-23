import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateEd25519KeyPair } from '@nexus-rh/crypto-audit';
import type { DatabaseSslMode } from '@nexus-rh/database';
import { INFRA_PROFILES, type InfraProfile } from '@nexus-rh/shared-types';

const SANDBOX_PREVIEW_ORIGIN_REGEX = /^https:\/\/[a-z0-9-]+\.e2b\.app$/i;
const SANDBOX_LOCAL_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly infraProfile: InfraProfile;
  readonly host: string;
  readonly port: number;
  readonly corsAllowedOrigins: string[];
  readonly databaseUrl: string | undefined;
  readonly databaseSslMode: DatabaseSslMode;
  readonly databaseSslCaCert: string | undefined;
  readonly pgliteDataDir: string;
  readonly redisUrl: string | undefined;
  readonly redisKeyPrefix: string;
  readonly rabbitmqUrl: string | undefined;
  readonly s3: {
    readonly endpoint: string | undefined;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string | undefined;
    readonly secretAccessKey: string | undefined;
    readonly forcePathStyle: boolean;
    readonly sandboxDir: string;
  };
  readonly security: {
    readonly masterKek: Buffer;
    readonly jwtPrivateKeyDerB64: string;
    readonly jwtPublicKeyDerB64: string;
    readonly jwtIssuer: string;
    readonly jwtAudience: string;
    readonly accessTtlSeconds: number;
    readonly refreshTtlSeconds: number;
    readonly cookieSecure: boolean;
    readonly trustedProxyCount: number;
    readonly maxFailedLoginAttempts: number;
    readonly lockoutMinutes: number;
    readonly mfaIssuerName: string;
  };
}

/**
 * Vérifie si une origine navigateur (`Origin`) est explicitement autorisée (D-06 / F-03) :
 * - En `production` et `docker` : liste blanche exacte `corsAllowedOrigins` uniquement.
 * - En `sandbox` (hors production) : liste blanche + localhost/127.0.0.1 + preview `https://<id>.e2b.app`.
 */
export function isAllowedBrowserOrigin(
  origin: string,
  config: Pick<AppConfig, 'nodeEnv' | 'infraProfile' | 'corsAllowedOrigins'>,
): boolean {
  const normalized = origin.trim().replace(/\/+$/, '');
  if (!normalized || normalized === 'null') {
    return false;
  }
  const allowSet = new Set(
    config.corsAllowedOrigins.map((entry) => entry.trim().replace(/\/+$/, '').toLowerCase()),
  );
  if (allowSet.has(normalized.toLowerCase())) {
    return true;
  }
  if (config.infraProfile === 'sandbox' && config.nodeEnv !== 'production') {
    return (
      SANDBOX_LOCAL_ORIGIN_REGEX.test(normalized) ||
      SANDBOX_PREVIEW_ORIGIN_REGEX.test(normalized)
    );
  }
  return false;
}

interface SandboxLocalSecrets {
  masterKekHex: string;
  jwtPrivateKeyDerB64: string;
  jwtPublicKeyDerB64: string;
}

function loadOrCreateSandboxSecrets(dataRoot: string, inMemoryOnly: boolean): SandboxLocalSecrets {
  if (inMemoryOnly) {
    const kp = generateEd25519KeyPair();
    return {
      masterKekHex: crypto.randomBytes(32).toString('hex'),
      jwtPrivateKeyDerB64: kp.privateKeyDerB64,
      jwtPublicKeyDerB64: kp.publicKeyDerB64,
    };
  }

  const secretPath = path.resolve(dataRoot, 'sandbox-local-keys.json');
  if (fs.existsSync(secretPath)) {
    return JSON.parse(fs.readFileSync(secretPath, 'utf8')) as SandboxLocalSecrets;
  }

  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  const kp = generateEd25519KeyPair();
  const generated: SandboxLocalSecrets = {
    masterKekHex: crypto.randomBytes(32).toString('hex'),
    jwtPrivateKeyDerB64: kp.privateKeyDerB64,
    jwtPublicKeyDerB64: kp.publicKeyDerB64,
  };
  fs.writeFileSync(secretPath, JSON.stringify(generated, null, 2), { mode: 0o600 });
  return generated;
}

function parseDatabaseSslMode(
  raw: string | undefined,
  infraProfile: InfraProfile,
): DatabaseSslMode {
  if (!raw || raw.trim() === '') {
    return infraProfile === 'production' ? 'verify-full' : 'disable';
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized !== 'disable' && normalized !== 'require' && normalized !== 'verify-full') {
    throw new Error(
      `DATABASE_SSL invalide : "${raw}". Valeurs admises : disable, require, verify-full.`,
    );
  }
  if (infraProfile === 'production' && normalized === 'disable') {
    throw new Error(
      'SÉCURITÉ CRITIQUE : DATABASE_SSL=disable est interdit lorsque INFRA_PROFILE=production.',
    );
  }
  return normalized;
}

function parseTrustedProxyCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
    throw new Error('TRUSTED_PROXY_COUNT doit être un entier compris entre 0 et 10.');
  }
  return parsed;
}

export interface LoadAppConfigOverrides {
  readonly pgliteDataDir?: string;
  readonly infraProfile?: InfraProfile;
  readonly nodeEnv?: AppConfig['nodeEnv'];
  readonly trustedProxyCount?: number;
  readonly corsAllowedOrigins?: string[];
}

export function loadAppConfig(overrides: LoadAppConfigOverrides = {}): AppConfig {
  const rawEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const nodeEnv: AppConfig['nodeEnv'] =
    rawEnv === 'production' || rawEnv === 'test' ? rawEnv : 'development';

  const rawProfile = overrides.infraProfile ?? process.env.INFRA_PROFILE ?? (nodeEnv === 'production' ? 'production' : 'sandbox');
  if (!INFRA_PROFILES.includes(rawProfile as InfraProfile)) {
    throw new Error(`INFRA_PROFILE invalide : "${rawProfile}". Valeurs admises : ${INFRA_PROFILES.join(', ')}`);
  }
  const infraProfile = rawProfile as InfraProfile;

  // Garde-fou absolu : jamais de profil sandbox en production
  if (nodeEnv === 'production' && infraProfile === 'sandbox') {
    throw new Error(
      'SÉCURITÉ CRITIQUE : INFRA_PROFILE=sandbox est strictement interdit lorsque NODE_ENV=production.',
    );
  }

  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const dataRoot = path.join(workspaceRoot, '.data');
  const pgliteDataDir =
    overrides.pgliteDataDir ??
    process.env.PGLITE_DATA_DIR ??
    (nodeEnv === 'test' ? 'memory://' : path.join(dataRoot, 'pglite'));

  let masterKekHex = process.env.MASTER_KEK_HEX?.trim() ?? '';
  let jwtPrivateKeyDerB64 = process.env.JWT_ED25519_PRIVATE_KEY_B64?.trim() ?? '';
  let jwtPublicKeyDerB64 = process.env.JWT_ED25519_PUBLIC_KEY_B64?.trim() ?? '';

  if (!masterKekHex || !jwtPrivateKeyDerB64 || !jwtPublicKeyDerB64) {
    if (infraProfile === 'production' || nodeEnv === 'production') {
      throw new Error(
        'SÉCURITÉ CRITIQUE : MASTER_KEK_HEX, JWT_ED25519_PRIVATE_KEY_B64 et JWT_ED25519_PUBLIC_KEY_B64 sont obligatoires en production.',
      );
    }
    // D-06 : en profil `docker`, refuser toute génération implicite de clés locales sur disque
    // sans consentement explicite `ALLOW_DEV_EPHEMERAL_KEYS=true`.
    if (infraProfile === 'docker' && process.env.ALLOW_DEV_EPHEMERAL_KEYS !== 'true') {
      throw new Error(
        'SÉCURITÉ : MASTER_KEK_HEX, JWT_ED25519_PRIVATE_KEY_B64 et JWT_ED25519_PUBLIC_KEY_B64 sont obligatoires en profil docker (aucune génération implicite de .data/sandbox-local-keys.json).',
      );
    }
    const sandboxSecrets = loadOrCreateSandboxSecrets(dataRoot, pgliteDataDir === 'memory://');
    masterKekHex = masterKekHex || sandboxSecrets.masterKekHex;
    jwtPrivateKeyDerB64 = jwtPrivateKeyDerB64 || sandboxSecrets.jwtPrivateKeyDerB64;
    jwtPublicKeyDerB64 = jwtPublicKeyDerB64 || sandboxSecrets.jwtPublicKeyDerB64;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(masterKekHex)) {
    throw new Error('MASTER_KEK_HEX doit contenir exactement 64 caractères hexadécimaux (256 bits).');
  }
  if (/^([0-9a-fA-F]{2})\1{31}$/.test(masterKekHex)) {
    throw new Error(
      'SÉCURITÉ CRITIQUE : MASTER_KEK_HEX présente une entropie nulle (octet répété interdit).',
    );
  }

  const databaseSslMode = parseDatabaseSslMode(process.env.DATABASE_SSL, infraProfile);
  const databaseSslCaB64 = process.env.DATABASE_SSL_CA_B64?.trim();
  const databaseSslCaCert = databaseSslCaB64
    ? Buffer.from(databaseSslCaB64, 'base64').toString('utf8')
    : undefined;
  const trustedProxyCount =
    overrides.trustedProxyCount ?? parseTrustedProxyCount(process.env.TRUSTED_PROXY_COUNT);

  const corsAllowedOrigins =
    overrides.corsAllowedOrigins ??
    (process.env.CORS_ALLOWED_ORIGINS ?? (nodeEnv === 'production' ? '' : 'http://localhost:3000'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  if (infraProfile === 'production') {
    for (const requiredVar of ['DATABASE_URL', 'REDIS_URL', 'RABBITMQ_URL', 'S3_BUCKET']) {
      if (!process.env[requiredVar]) {
        throw new Error(`Configuration de production incomplète : ${requiredVar} manquant.`);
      }
    }
    if (corsAllowedOrigins.some((o) => o === '*')) {
      throw new Error(
        'SÉCURITÉ CRITIQUE : CORS_ALLOWED_ORIGINS ne peut jamais contenir le joker "*" en production.',
      );
    }
  }

  return {
    nodeEnv,
    infraProfile,
    host: process.env.API_HOST ?? '0.0.0.0',
    port: Number(process.env.API_PORT ?? 4000),
    corsAllowedOrigins,
    databaseUrl: process.env.DATABASE_URL,
    databaseSslMode,
    databaseSslCaCert,
    pgliteDataDir,
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: process.env.REDIS_KEY_PREFIX ?? `nexus:${nodeEnv}`,
    rabbitmqUrl: process.env.RABBITMQ_URL,
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'eu-west-3',
      bucket: process.env.S3_BUCKET ?? 'nexus-rh-documents',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      sandboxDir: process.env.SANDBOX_STORAGE_DIR ?? path.join(dataRoot, 'object-storage'),
    },
    security: {
      masterKek: Buffer.from(masterKekHex, 'hex'),
      jwtPrivateKeyDerB64,
      jwtPublicKeyDerB64,
      jwtIssuer: process.env.JWT_ISSUER ?? 'nexus-rh',
      jwtAudience: process.env.JWT_AUDIENCE ?? 'nexus-rh-app',
      accessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
      refreshTtlSeconds: Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 604_800),
      cookieSecure:
        process.env.COOKIE_SECURE !== undefined
          ? process.env.COOKIE_SECURE === 'true'
          : nodeEnv === 'production',
      trustedProxyCount,
      maxFailedLoginAttempts: Number(process.env.AUTH_MAX_FAILED_ATTEMPTS ?? 5),
      lockoutMinutes: Number(process.env.AUTH_LOCKOUT_MINUTES ?? 15),
      mfaIssuerName: process.env.MFA_ISSUER_NAME ?? 'NEXUS RH',
    },
  };
}

function findWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
}
