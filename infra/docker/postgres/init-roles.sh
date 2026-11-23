#!/usr/bin/env sh
set -eu

# Création séparée du rôle de migration DDL (nexus_migrator) et du rôle
# applicatif (nexus_app) strictement dépourvu de SUPERUSER et BYPASSRLS
# afin de garantir l'application obligatoire de PostgreSQL Row-Level Security.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_migrator') THEN
      CREATE ROLE nexus_migrator LOGIN PASSWORD '${NEXUS_MIGRATOR_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
      CREATE ROLE nexus_app LOGIN PASSWORD '${NEXUS_APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO nexus_migrator, nexus_app;
  GRANT USAGE, CREATE ON SCHEMA public TO nexus_migrator;
  GRANT USAGE ON SCHEMA public TO nexus_app;
  GRANT nexus_app TO nexus_migrator;

  -- Moindre privilège strict : aucun UPDATE/DELETE global automatique (audit_logs append-only) ;
  -- chaque migration SQL attribue explicitement les seuls droits requis par table.
  ALTER DEFAULT PRIVILEGES FOR ROLE nexus_migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO nexus_app;
EOSQL
