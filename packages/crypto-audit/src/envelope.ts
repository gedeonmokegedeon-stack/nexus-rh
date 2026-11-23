import crypto from 'node:crypto';

/**
 * Chiffrement d'enveloppe AES-256-GCM isolé par tenant (SECURITY_POLICY.md).
 *
 * Fonctionnement :
 * 1. Une clé d'enveloppe dédiée au tenant (Tenant KEK, 256 bits) est dérivée via
 *    HKDF-SHA256 à partir de la clé maîtresse (Master KEK) et du couple (tenantId, keyRef).
 * 2. Chaque enregistrement sensible (secret MFA, compte bancaire, ou gabarit biométrique
 *    lorsque légalement autorisé) reçoit une clé de données aléatoire unique (DEK, 256 bits).
 * 3. La donnée est chiffrée en AES-256-GCM avec la DEK et des données additionnelles
 *    authentifiées (AAD = `nexus-rh:v1:{tenantId}:{purpose}:{recordId}`), empêchant
 *    toute copie d'un texte chiffré vers un autre tenant ou un autre usage.
 * 4. La DEK est chiffrée en AES-256-GCM avec la Tenant KEK.
 */

export interface EnvelopeCiphertext {
  readonly version: 1;
  readonly ciphertextB64: string;
  readonly ivB64: string;
  readonly authTagB64: string;
  readonly wrappedDekB64: string;
  readonly dekIvB64: string;
  readonly dekAuthTagB64: string;
}

export interface EnvelopeContext {
  readonly tenantScope: string; // UUID du tenant ou 'platform' pour un secret hors-tenant (ex. MFA superadmin)
  readonly keyRef: string;
  readonly purpose:
    | 'mfa_secret'
    | 'bank_account'
    | 'biometric_template'
    | 'webhook_secret'
    | 'badge_totp'
    | 'employee_pii'
    | 'employee_payment'
    | 'employee_salary'
    | 'document_blob';
  readonly recordId: string;
}

function assertValidMasterKey(masterKek: Buffer): void {
  if (!Buffer.isBuffer(masterKek) || masterKek.length !== 32) {
    throw new Error('MASTER_KEK invalide : une clé exacte de 32 octets (256 bits) est requise.');
  }
}

function deriveTenantKek(masterKek: Buffer, tenantScope: string, keyRef: string): Buffer {
  assertValidMasterKey(masterKek);
  const derived = crypto.hkdfSync(
    'sha256',
    masterKek,
    Buffer.from(`nexus-rh-salt:${tenantScope}`, 'utf8'),
    Buffer.from(`nexus-rh-tenant-kek:v1:${tenantScope}:${keyRef}`, 'utf8'),
    32,
  );
  return Buffer.from(derived);
}

function buildAad(ctx: EnvelopeContext): Buffer {
  return Buffer.from(
    `nexus-rh:v1:${ctx.tenantScope}:${ctx.keyRef}:${ctx.purpose}:${ctx.recordId}`,
    'utf8',
  );
}

export function encryptEnvelope(
  masterKek: Buffer,
  plaintext: Buffer | string,
  ctx: EnvelopeContext,
): EnvelopeCiphertext {
  const tenantKek = deriveTenantKek(masterKek, ctx.tenantScope, ctx.keyRef);
  const dek = crypto.randomBytes(32);
  const dataIv = crypto.randomBytes(12);
  const dekIv = crypto.randomBytes(12);
  const aad = buildAad(ctx);

  try {
    const dataBuffer = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
    const dataCipher = crypto.createCipheriv('aes-256-gcm', dek, dataIv);
    dataCipher.setAAD(aad);
    const ciphertext = Buffer.concat([dataCipher.update(dataBuffer), dataCipher.final()]);
    const authTag = dataCipher.getAuthTag();

    const dekCipher = crypto.createCipheriv('aes-256-gcm', tenantKek, dekIv);
    dekCipher.setAAD(aad);
    const wrappedDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
    const dekAuthTag = dekCipher.getAuthTag();

    return {
      version: 1,
      ciphertextB64: ciphertext.toString('base64'),
      ivB64: dataIv.toString('base64'),
      authTagB64: authTag.toString('base64'),
      wrappedDekB64: wrappedDek.toString('base64'),
      dekIvB64: dekIv.toString('base64'),
      dekAuthTagB64: dekAuthTag.toString('base64'),
    };
  } finally {
    // Effacement mémoire immédiat des clés éphémères
    dek.fill(0);
    tenantKek.fill(0);
  }
}

export function decryptEnvelope(
  masterKek: Buffer,
  envelope: EnvelopeCiphertext,
  ctx: EnvelopeContext,
): Buffer {
  if (envelope.version !== 1) {
    throw new Error(`Version d'enveloppe cryptographique non supportée : ${String(envelope.version)}`);
  }
  const tenantKek = deriveTenantKek(masterKek, ctx.tenantScope, ctx.keyRef);
  const aad = buildAad(ctx);
  let dek: Buffer | null = null;

  try {
    const dekDecipher = crypto.createDecipheriv(
      'aes-256-gcm',
      tenantKek,
      Buffer.from(envelope.dekIvB64, 'base64'),
    );
    dekDecipher.setAAD(aad);
    dekDecipher.setAuthTag(Buffer.from(envelope.dekAuthTagB64, 'base64'));
    dek = Buffer.concat([
      dekDecipher.update(Buffer.from(envelope.wrappedDekB64, 'base64')),
      dekDecipher.final(),
    ]);

    const dataDecipher = crypto.createDecipheriv(
      'aes-256-gcm',
      dek,
      Buffer.from(envelope.ivB64, 'base64'),
    );
    dataDecipher.setAAD(aad);
    dataDecipher.setAuthTag(Buffer.from(envelope.authTagB64, 'base64'));
    return Buffer.concat([
      dataDecipher.update(Buffer.from(envelope.ciphertextB64, 'base64')),
      dataDecipher.final(),
    ]);
  } finally {
    tenantKek.fill(0);
    if (dek) dek.fill(0);
  }
}

/**
 * Calcule un index aveugle HMAC-SHA256 isolé par tenant (clé dérivée HKDF dédiée)
 * permettant de détecter les doublons d'identifiants sensibles (ex. N° CNSS, N° pièce
 * d'identité) au sein d'une même entreprise SANS jamais stocker la valeur en clair
 * et sans permettre de corrélation inter-entreprises.
 */
export function computeTenantBlindIndex(
  masterKek: Buffer,
  tenantId: string,
  keyRef: string,
  fieldName: 'cnss_number' | 'identity_doc_number' | 'individual_tax_id',
  rawValue: string,
): string {
  assertValidMasterKey(masterKek);
  const normalized = rawValue.trim().toUpperCase().replace(/[\s./-]+/g, '');
  if (!normalized) {
    throw new Error('Impossible de calculer un index aveugle sur une valeur vide.');
  }
  const indexKey = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      masterKek,
      Buffer.from(`nexus-rh-blind-salt:${tenantId}`, 'utf8'),
      Buffer.from(`nexus-rh-blind-index:v1:${tenantId}:${keyRef}:${fieldName}`, 'utf8'),
      32,
    ),
  );
  try {
    return crypto.createHmac('sha256', indexKey).update(normalized, 'utf8').digest('hex');
  } finally {
    indexKey.fill(0);
  }
}

/**
 * Produit une représentation masquée irréversible pour l'affichage courant (ex. "••••••4821").
 */
export function maskSensitiveValue(rawValue: string, visibleTail: number = 4): string {
  const clean = rawValue.trim();
  if (!clean) return '';
  if (clean.length <= visibleTail) {
    return '•'.repeat(Math.max(4, clean.length));
  }
  const tail = clean.slice(-visibleTail);
  const maskedLen = Math.min(8, Math.max(4, clean.length - visibleTail));
  return `${'•'.repeat(maskedLen)}${tail}`;
}
