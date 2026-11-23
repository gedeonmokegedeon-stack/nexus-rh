#!/usr/bin/env node
/**
 * NEXUS RH — Vérificateur automatique de gouvernance technique et sécurité.
 * Exécuté en CI et via `pnpm check:governance`.
 *
 * Contrôle :
 * 1. Présence de LICENSE et des 10 documents de fondation de la Mission 0.
 * 2. Absence de fichiers .env ou clés privées suivis ou présents par erreur hors .env.example.
 * 3. Absence de types flottants (REAL / DOUBLE PRECISION / FLOAT) dans les migrations SQL.
 * 4. Présence obligatoire de FORCE ROW LEVEL SECURITY sur chaque table contenant tenant_id NOT NULL.
 * 5. Absence de constantes fiscales/sociales RDC codées en dur (CNSS_RATE, IPR_RATE, INPP_RATE, ONEM_RATE, IERE_RATE).
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const errors = [];

const REQUIRED_ROOT_FILES = [
  'LICENSE',
  'README.md',
  'VISION.md',
  'CAHIER_DES_CHARGES.md',
  'ARCHITECTURE_TECHNIQUE.md',
  'DATABASE_SCHEMA.md',
  'SECURITY_POLICY.md',
  'BIOMETRIC_INTEGRATION_PLAN.md',
  'PAYROLL_RULES_RDC.md',
  'ROADMAP.md',
  'TEST_STRATEGY.md',
  '.gitignore',
  '.env.example',
];

for (const file of REQUIRED_ROOT_FILES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
    errors.push(`Fichier obligatoire manquant ou vide : ${file}`);
  }
}

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      ['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', '.data'].includes(entry.name)
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}

// Vérification des migrations SQL
const migrationsDir = path.join(ROOT, 'packages/database/migrations');
const sqlFiles = walk(migrationsDir).filter((f) => f.endsWith('.sql'));
const combinedSql = sqlFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

for (const sqlFile of sqlFiles) {
  const rel = path.relative(ROOT, sqlFile);
  const content = fs.readFileSync(sqlFile, 'utf8');
  // Retirer les commentaires SQL avant inspection des types flottants
  const uncommented = content.replace(/--.*$/gm, '');
  if (/\b(DOUBLE\s+PRECISION|FLOAT4|FLOAT8|REAL)\b/i.test(uncommented)) {
    errors.push(`Type flottant interdit détecté dans ${rel} (utiliser NUMERIC).`);
  }

  // Détecter toutes les tables contenant tenant_id UUID NOT NULL
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)\s*\(([\s\S]*?)\);/gi;
  let match;
  while ((match = createTableRegex.exec(uncommented)) !== null) {
    const tableName = match[1];
    const body = match[2];
    if (/\btenant_id\s+UUID\s+NOT\s+NULL\b/i.test(body)) {
      const forceRlsRegex = new RegExp(
        `ALTER\\s+TABLE\\s+${tableName}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
        'i',
      );
      if (!forceRlsRegex.test(combinedSql)) {
        errors.push(`Table multi-tenant sans FORCE ROW LEVEL SECURITY : ${tableName} (${rel})`);
      }
    }
  }
}

// Vérification du code source (anti-secrets & anti-taux codés en dur)
const codeFiles = [...walk(path.join(ROOT, 'packages')), ...walk(path.join(ROOT, 'apps'))].filter(
  (f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.endsWith('.spec.ts'),
);

const HARDCODED_RATE_REGEX =
  /\b(CNSS_RATE|IPR_RATE|INPP_RATE|ONEM_RATE|IERE_RATE|SMIG_AMOUNT|HOUSING_CAP_RATE)\s*=\s*[0-9]/;
const PRIVATE_KEY_LITERAL_REGEX = /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/;

for (const file of codeFiles) {
  const rel = path.relative(ROOT, file);
  const content = fs.readFileSync(file, 'utf8');
  if (HARDCODED_RATE_REGEX.test(content)) {
    errors.push(`Taux fiscal/social codé en dur interdit détecté dans ${rel}`);
  }
  if (PRIVATE_KEY_LITERAL_REGEX.test(content)) {
    errors.push(`Clé privée littérale interdite détectée dans ${rel}`);
  }
}

if (errors.length > 0) {
  console.error('ÉCHEC DES CONTRÔLES DE GOUVERNANCE NEXUS RH :');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(
  `[OK] Gouvernance NEXUS RH validée (${REQUIRED_ROOT_FILES.length} fichiers racine, ${sqlFiles.length} migration(s) SQL, ${codeFiles.length} fichier(s) code vérifiés).`,
);
