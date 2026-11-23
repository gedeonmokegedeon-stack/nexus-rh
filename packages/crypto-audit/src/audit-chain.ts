import { sha256Hex } from './uuidv7';

/**
 * Journal d'audit immuable chaîné cryptographiquement par SHA-256 (SECURITY_POLICY.md).
 * Chaque entrée inclut `prevHash` (empreinte de l'entrée précédente de la même chaîne)
 * et `entryHash = SHA256(prevHash + "|" + canonicalJson(entry))`.
 * Toute modification, suppression ou réinsertion d'une entrée brise immédiatement la chaîne.
 */

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

const SENSITIVE_FIELD_PATTERNS = [
  /password/i,
  /pin/i,
  /secret/i,
  /token/i,
  /template/i,
  /dek/i,
  /kek/i,
  /privatekey/i,
  /ciphertext/i,
  /encrypted/i,
  /blindindex/i,
  /iban/i,
  /accountnumber/i,
  /bankaccount/i,
  /mobilemoneynumber/i,
  /identitydocnumber/i,
  /cnssnumber/i,
  /individualtaxid/i,
  /basesalary/i,
  /qrpayload/i,
  /contentbase64/i,
  /recoverycode/i,
];

export function redactSensitiveFields(value: unknown, depth: number = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item, depth + 1));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
        result[key] = '[EXPURGÉ]';
      } else {
        result[key] = redactSensitiveFields(val, depth + 1);
      }
    }
    return result;
  }
  return value;
}

/**
 * Sérialisation JSON canonique (clés triées récursivement) pour garantir un hash
 * identique même après aller-retour dans une colonne PostgreSQL JSONB.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export interface AuditHashInput {
  readonly id: string;
  readonly chainScope: string; // UUID du tenant ou 'PLATFORM'
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly reason: string | null;
  readonly beforeState: unknown;
  readonly afterState: unknown;
  readonly occurredAtIso: string;
  readonly prevHash: string;
}

export interface StoredAuditChainEntry extends AuditHashInput {
  readonly seqNo: number | string;
  readonly entryHash: string;
}

export interface AuditChainVerificationResult {
  readonly valid: boolean;
  readonly checkedCount: number;
  readonly headHash: string;
  readonly brokenAtId: string | null;
  readonly brokenAtSeqNo: string | null;
  readonly failureReason: string | null;
}

export function computeAuditEntryHash(entry: AuditHashInput): string {
  const payload = canonicalJson({
    id: entry.id,
    chainScope: entry.chainScope,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    reason: entry.reason,
    beforeState: entry.beforeState ?? null,
    afterState: entry.afterState ?? null,
    occurredAtIso: new Date(entry.occurredAtIso).toISOString(),
  });
  return sha256Hex(`${entry.prevHash}|${payload}`);
}

export function verifyAuditChain(
  orderedEntries: readonly StoredAuditChainEntry[],
  initialPrevHash: string = AUDIT_GENESIS_HASH,
): AuditChainVerificationResult {
  let expectedPrevHash = initialPrevHash;
  let verifiedSoFar = 0;

  for (const entry of orderedEntries) {
    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        checkedCount: verifiedSoFar,
        headHash: expectedPrevHash,
        brokenAtId: entry.id,
        brokenAtSeqNo: String(entry.seqNo),
        failureReason: `Rupture du chaînage prev_hash à l'entrée #${String(entry.seqNo)} (suppression ou réordonnancement détecté).`,
      };
    }

    const recomputed = computeAuditEntryHash(entry);
    if (recomputed !== entry.entryHash) {
      return {
        valid: false,
        checkedCount: verifiedSoFar,
        headHash: expectedPrevHash,
        brokenAtId: entry.id,
        brokenAtSeqNo: String(entry.seqNo),
        failureReason: `Empreinte SHA-256 invalide à l'entrée #${String(entry.seqNo)} (altération de contenu détectée).`,
      };
    }

    expectedPrevHash = entry.entryHash;
    verifiedSoFar += 1;
  }

  return {
    valid: true,
    checkedCount: orderedEntries.length,
    headHash: expectedPrevHash,
    brokenAtId: null,
    brokenAtSeqNo: null,
    failureReason: null,
  };
}
