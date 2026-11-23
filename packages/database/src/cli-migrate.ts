import { NexusDatabase, type DatabaseSslMode } from './client';
import type { InfraProfile } from '@nexus-rh/shared-types';

function parseCliSslMode(raw: string | undefined): DatabaseSslMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'disable' || normalized === 'require' || normalized === 'verify-full') {
    return normalized;
  }
  throw new Error(
    `DATABASE_SSL invalide ("${raw}"). Valeurs autorisées : disable | require | verify-full.`,
  );
}

async function main(): Promise<void> {
  const profile = (process.env.INFRA_PROFILE ?? 'sandbox') as InfraProfile;
  const sslCaB64 = process.env.DATABASE_SSL_CA_B64?.trim();
  const db = await NexusDatabase.connect({
    profile,
    connectionString: process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL,
    sslMode: parseCliSslMode(process.env.DATABASE_SSL),
    sslCaCert: sslCaB64 ? Buffer.from(sslCaB64, 'base64').toString('utf8') : undefined,
    pgliteDataDir: process.env.PGLITE_DATA_DIR ?? '.data/pglite',
  });

  try {
    const migrations = await db.runMigrations();
    const catalog = await db.seedSystemCatalog();
    const health = await db.ping();
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          driver: db.driverKind,
          pgVersion: health.pgVersion,
          forceRlsTables: health.rlsTablesCount,
          migrationsApplied: migrations.map((m) => m.filename),
          systemCatalog: catalog,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[ERREUR MIGRATION]', err);
  process.exit(1);
});
