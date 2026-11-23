import crypto from 'node:crypto';
import { sha256Hex } from './uuidv7';

/**
 * Badges QR Code d'identification alternative (QR + PIN Argon2id).
 *
 * Format du jeton encodé dans le QR Code :
 *   NXRH1.<tenantId>.<badgeId>.<nonce128B64url>.<hmacSha256B64url>
 *
 * Garanties de sécurité :
 * - Aucune donnée personnelle ni biométrique dans le QR Code.
 * - Nonce aléatoire de 128 bits (irréversible et imprévisible).
 * - Signature HMAC-SHA256 dérivée par tenant via HKDF-SHA256 : infalsifiable et
 *   strictement non transférable d'une entreprise à une autre.
 * - Seul `qrTokenHash = SHA-256(qrPayload)` est persisté en base PostgreSQL :
 *   une fuite en lecture seule de la base ne permet jamais de reconstruire un badge valide.
 * - Exige toujours la saisie conjointe du code PIN personnel (vérifié en Argon2id).
 */

const QR_PREFIX = 'NXRH1';
const UUID_V_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deriveTenantBadgeSigningKey(masterKek: Buffer, tenantId: string, keyRef: string): Buffer {
  if (!Buffer.isBuffer(masterKek) || masterKek.length !== 32) {
    throw new Error('MASTER_KEK invalide (32 octets attendus).');
  }
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      masterKek,
      Buffer.from(`nexus-rh-badge-salt:${tenantId}`, 'utf8'),
      Buffer.from(`nexus-rh-badge-hmac:v1:${tenantId}:${keyRef}`, 'utf8'),
      32,
    ),
  );
}

export interface IssuedBadgeQrToken {
  readonly qrPayload: string;
  readonly qrTokenHash: string;
}

export interface ParsedBadgeQrToken {
  readonly tenantId: string;
  readonly badgeId: string;
  readonly nonceB64url: string;
  readonly signatureB64url: string;
  readonly qrTokenHash: string;
}

export function issueSignedBadgeQrToken(params: {
  readonly masterKek: Buffer;
  readonly tenantId: string;
  readonly keyRef: string;
  readonly badgeId: string;
}): IssuedBadgeQrToken {
  if (!UUID_V_REGEX.test(params.tenantId) || !UUID_V_REGEX.test(params.badgeId)) {
    throw new Error('Identifiants tenantId/badgeId invalides pour le badge QR.');
  }
  const nonceB64url = crypto.randomBytes(16).toString('base64url');
  const signingInput = `${QR_PREFIX}.${params.tenantId}.${params.badgeId}.${nonceB64url}`;
  const signingKey = deriveTenantBadgeSigningKey(params.masterKek, params.tenantId, params.keyRef);

  try {
    const sigB64url = crypto
      .createHmac('sha256', signingKey)
      .update(signingInput, 'ascii')
      .digest('base64url');
    const qrPayload = `${signingInput}.${sigB64url}`;
    return {
      qrPayload,
      qrTokenHash: sha256Hex(qrPayload),
    };
  } finally {
    signingKey.fill(0);
  }
}

export function parseBadgeQrPayload(rawQrPayload: string): ParsedBadgeQrToken | null {
  const clean = rawQrPayload.trim();
  const parts = clean.split('.');
  if (parts.length !== 5) return null;
  const [prefix, tenantId, badgeId, nonceB64url, signatureB64url] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (prefix !== QR_PREFIX) return null;
  if (!UUID_V_REGEX.test(tenantId) || !UUID_V_REGEX.test(badgeId)) return null;
  if (!/^[A-Za-z0-9_-]{20,32}$/.test(nonceB64url)) return null;
  if (!/^[A-Za-z0-9_-]{42,46}$/.test(signatureB64url)) return null;

  return {
    tenantId: tenantId.toLowerCase(),
    badgeId: badgeId.toLowerCase(),
    nonceB64url,
    signatureB64url,
    qrTokenHash: sha256Hex(clean),
  };
}

export function verifySignedBadgeQrToken(params: {
  readonly masterKek: Buffer;
  readonly expectedTenantId: string;
  readonly keyRef: string;
  readonly rawQrPayload: string;
}): { valid: true; badgeId: string; qrTokenHash: string } | { valid: false } {
  const parsed = parseBadgeQrPayload(params.rawQrPayload);
  if (!parsed) return { valid: false };
  if (parsed.tenantId !== params.expectedTenantId.toLowerCase()) {
    return { valid: false };
  }

  const clean = params.rawQrPayload.trim();
  const lastDot = clean.lastIndexOf('.');
  const signingInput = clean.slice(0, lastDot);
  const signingKey = deriveTenantBadgeSigningKey(
    params.masterKek,
    params.expectedTenantId,
    params.keyRef,
  );

  try {
    const expectedSig = crypto
      .createHmac('sha256', signingKey)
      .update(signingInput, 'ascii')
      .digest();
    const candidateSig = Buffer.from(parsed.signatureB64url, 'base64url');
    if (
      candidateSig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(expectedSig, candidateSig)
    ) {
      return { valid: false };
    }
    return {
      valid: true,
      badgeId: parsed.badgeId,
      qrTokenHash: parsed.qrTokenHash,
    };
  } finally {
    signingKey.fill(0);
  }
}
