import crypto from 'node:crypto';
import { sha256Hex } from './uuidv7';

/**
 * Authentification Multi-Facteurs TOTP conforme aux RFC 4226 (HOTP), RFC 4648 (Base32)
 * et RFC 6238 (TOTP — pas de 30 secondes, 6 chiffres, HMAC-SHA1 compatible Google Authenticator,
 * Microsoft Authenticator, Authy, FreeOTP, 1Password, Bitwarden).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error('Secret Base32 invalide.');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  // 20 octets = 160 bits d'entropie (recommandation RFC 6238)
  return base32Encode(crypto.randomBytes(20));
}

export function buildTotpOtpAuthUri(params: {
  readonly secretBase32: string;
  readonly accountEmail: string;
  readonly issuer: string;
}): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountEmail)}`;
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export function generateTotpCode(secretBase32: string, nowMs: number = Date.now()): string {
  const counter = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  return computeHotp(secretBase32, counter);
}

function computeHotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac('sha1', key).update(counterBuf).digest();
  key.fill(0);

  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  const otp = binary % 10 ** TOTP_DIGITS;
  return String(otp).padStart(TOTP_DIGITS, '0');
}

/**
 * Vérifie un code TOTP en temps constant avec une tolérance d'horloge contrôlée (±1 pas = ±30 s)
 * et retourne le compteur accepté afin d'empêcher tout rejeu du même code.
 */
export function verifyTotpCode(
  secretBase32: string,
  candidateCode: string,
  options: { nowMs?: number; windowSteps?: number; lastUsedStep?: number | null } = {},
): { valid: boolean; matchedStep: number | null } {
  const clean = candidateCode.trim();
  if (!/^\d{6}$/.test(clean)) {
    return { valid: false, matchedStep: null };
  }

  const nowMs = options.nowMs ?? Date.now();
  const windowSteps = options.windowSteps ?? 1;
  const currentStep = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  const candidateBuf = Buffer.from(clean, 'ascii');

  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const step = currentStep + delta;
    if (options.lastUsedStep !== undefined && options.lastUsedStep !== null && step <= options.lastUsedStep) {
      continue; // Protection anti-rejeu TOTP
    }
    const expectedBuf = Buffer.from(computeHotp(secretBase32, step), 'ascii');
    if (crypto.timingSafeEqual(expectedBuf, candidateBuf)) {
      return { valid: true, matchedStep: step };
    }
  }
  return { valid: false, matchedStep: null };
}

/**
 * Génère 8 codes de secours à usage unique (format XXXX-XXXX) et leurs empreintes SHA-256 salées.
 */
export function generateRecoveryCodes(
  userId: string,
  count: number = 8,
): { plainCodes: string[]; hashedCodes: string[] } {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];

  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(8);
    let raw = '';
    for (const b of bytes) {
      raw += alphabet[b % alphabet.length];
    }
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    plainCodes.push(formatted);
    hashedCodes.push(hashRecoveryCode(userId, formatted));
  }
  return { plainCodes, hashedCodes };
}

export function hashRecoveryCode(userId: string, code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return sha256Hex(`nexus-rh-recovery:v1:${userId}:${normalized}`);
}
