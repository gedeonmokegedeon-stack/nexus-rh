import crypto from 'node:crypto';

/**
 * Génère un identifiant UUIDv7 conforme à la RFC 9562 (ordonné temporellement
 * sur 48 bits en millisecondes + 74 bits d'entropie cryptographique CSPRNG).
 * Optimise les insertions B-Tree sur PostgreSQL sans révéler de compteur séquentiel.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = crypto.randomBytes(16);
  const ts = BigInt(nowMs);

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // Version 7 (0b0111xxxx)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // Variante RFC 4122 / 9562 (0b10xxxxxx)
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
