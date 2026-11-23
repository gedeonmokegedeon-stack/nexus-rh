import crypto from 'node:crypto';
import { sha256Hex, uuidv7 } from './uuidv7';

/**
 * Gestion des jetons JWT signés asymétriquement en Ed25519 (EdDSA — RFC 8037)
 * et des Refresh Tokens opaques à haute entropie (256 bits).
 *
 * Séparation stricte par champ `typ` :
 * - 'access'        : jeton d'accès API à durée de vie courte (15 min par défaut)
 * - 'mfa_challenge' : jeton transitoire (5 min) ne donnant accès qu'à la validation MFA
 */

export interface Ed25519KeyPairEncoded {
  readonly privateKeyDerB64: string;
  readonly publicKeyDerB64: string;
}

export interface AccessTokenClaims {
  readonly typ: 'access';
  readonly sub: string;
  readonly sid: string;
  readonly tid: string | null;
  readonly sa: boolean; // is_platform_superadmin
  readonly mfa: boolean; // MFA vérifié sur cette session
  readonly jti: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
}

export interface MfaChallengeClaims {
  readonly typ: 'mfa_challenge';
  readonly sub: string;
  readonly jti: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
}

export function generateEd25519KeyPair(): Ed25519KeyPairEncoded {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyDerB64: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
    publicKeyDerB64: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
  };
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function signEdDsaJwt<T extends AccessTokenClaims | MfaChallengeClaims>(
  payload: Omit<T, 'jti' | 'iat' | 'exp'>,
  privateKeyDerB64: string,
  ttlSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { token: string; claims: T } {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyDerB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  const fullClaims = {
    ...payload,
    jti: uuidv7(),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  } as T;

  const headerSegment = base64UrlEncode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payloadSegment = base64UrlEncode(JSON.stringify(fullClaims));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = crypto.sign(null, Buffer.from(signingInput, 'ascii'), privateKey);

  return {
    token: `${signingInput}.${base64UrlEncode(signature)}`,
    claims: fullClaims,
  };
}

export function verifyEdDsaJwt<T extends AccessTokenClaims | MfaChallengeClaims>(
  token: string,
  publicKeyDerB64: string,
  expected: {
    readonly typ: T['typ'];
    readonly iss: string;
    readonly aud: string;
    readonly nowSeconds?: number;
  },
): T {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Format JWT invalide.');
  }
  const [headerSeg, payloadSeg, sigSeg] = parts as [string, string, string];
  if (!headerSeg || !payloadSeg || !sigSeg) {
    throw new Error('Segment JWT manquant.');
  }

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(base64UrlDecode(headerSeg).toString('utf8')) as {
      alg?: unknown;
      typ?: unknown;
    };
  } catch {
    throw new Error('En-tête JWT illisible.');
  }

  // Rejet strict de toute attaque de confusion d'algorithme (alg: none, HS256, etc.)
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT') {
    throw new Error('Algorithme JWT non autorisé.');
  }

  const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyDerB64, 'base64'),
    format: 'der',
    type: 'spki',
  });

  const signingInput = Buffer.from(`${headerSeg}.${payloadSeg}`, 'ascii');
  const signature = base64UrlDecode(sigSeg);
  if (signature.length !== 64 || !crypto.verify(null, signingInput, publicKey, signature)) {
    throw new Error('Signature JWT invalide.');
  }

  const claims = JSON.parse(base64UrlDecode(payloadSeg).toString('utf8')) as T;
  const now = expected.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (claims.typ !== expected.typ) {
    throw new Error('Type de jeton non autorisé pour cette opération.');
  }
  if (claims.iss !== expected.iss || claims.aud !== expected.aud) {
    throw new Error('Émetteur ou audience JWT invalide.');
  }
  if (typeof claims.exp !== 'number' || now >= claims.exp) {
    throw new Error('Jeton JWT expiré.');
  }
  if (typeof claims.iat !== 'number' || claims.iat > now + 30) {
    throw new Error('Horodatage JWT invalide.');
  }
  if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string') {
    throw new Error('Revendications JWT incomplètes.');
  }

  return claims;
}

export function generateOpaqueRefreshToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  return {
    rawToken,
    tokenHash: sha256Hex(rawToken),
  };
}

export function hashOpaqueToken(rawToken: string): string {
  return sha256Hex(rawToken);
}
