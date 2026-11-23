# PLAN DE MODIFICATIONS — PHASE C (LOCAL / CLOUD / HYBRIDE)

> **PHASE C — Plan précis des modifications. Aucune implémentation n'est effectuée durant cette phase.**
> Règles absolues : ne supprimer/remplacer/reconstruire aucun module existant ; ne modifier **aucune migration déjà validée (0001–0004)** ; aucun push/merge/publication.
> Tous les changements sont **minimaux, justifiés et compatibles**. Les extensions DB utilisent des **migrations additives** (nouveaux fichiers).

---

## 0. Ordre d'exécution global (recommandé)

| Étape | Thème | Résultat |
|---|---|---|
| **C0** | Re-capture Git (fait — commit `bcbf6ba`) + archives (fait) | Base sécurisée |
| **C1** | Schéma additive : licences + synchronisation | Extensions DB |
| **C2** | Module licences (cœur) | Commercialisation |
| **C3** | Module synchronisation (cœur, bidirectionnelle) | HYBRIDE |
| **C4** | `apps/edge-agent` | HYBRIDE/LOCAL |
| **C5** | `apps/device-gateway` + `packages/biometric-connectors` | Biométrie |
| **C6** | `apps/worker` | Asynchrone |
| **C7** | `apps/kiosk` (PWA hors ligne) | Hors ligne |
| **C8** | Installation/exploitation locale + sauvegarde/restauration | LOCAL |
| **C9** | Documentation livrables + tests non-régression | Livraisons |

Chaque étape est **indépendante et testable** ; on ne passe à la suivante après validation de la précédente.

---

## C1 — SCHEMA ADDITIVE (migrations NOUVELLES, sans toucher 0001–0004)

### Fichiers à créer
- `packages/database/migrations/0005_hybrid_sync_and_licensing.sql`

### Contenu (ajoutif, rétrocompatible)
**a) Système de licences commerciales** (`licenses`, `license_entitlements`) :
- `licenses(id, tenant_id, mode [LOCAL|CLOUD|HYBRIDE], plan_code, issued_at, expires_at, max_users, max_sites, status [ACTIVE|EXPIRED|SUSPENDED|REVOKED], metadata jsonb)`
- `license_entitlements(license_id, capability, limit, used)`
- Index sur `tenant_id`, `status`, `expires_at`.
- **Ne bloque JAMAIS** l'accès aux données, la restauration ou l'export (logique application, pas contrainte DB restrictive).

**b) Journal de synchronisation hybride** (`sync_events`) :
- `sync_events(id, tenant_id, site_id, direction [LOCAL_TO_CLOUD|CLOUD_TO_LOCAL], entity_type, entity_id, idempotency_key UNIQUE, state [PENDING|SYNCED|FAILED|CONFLICT], conflict_resolution, hash_payload, payload jsonb, attempts, last_error, synced_at, created_at)`
- Index sur `(tenant_id, state)`, `idempotency_key`, `(site_id, created_at)`.
- Sécurité : politique RLS **ajoutable** pour `sync_events` (isolation tenant).

**c) Tampon locaux** (si nécessaire en base) : `sync_local_buffers` (site_id, entity, payload, idempotency_key, created_at) — pour Edge Agent.

### Fichiers à modifier
- **Aucun** dans les migrations existantes.
- `packages/database/src/schema.ts` : **ajout** des tables Drizzle (nouvelles exports, sans toucher aux existantes).
- `packages/database/src/index.ts` : **ajout** des types/interfaces (additif).

### Risques
- Nouvelles tables RLS : vérifier que les politiques respectent l'isolation tenant (test dédié).
- Contrainte `idempotency_key UNIQUE` : nécessite un pré-traitement pour éviter les conflits de ré-insertion (logique application).

### Tests de validation
- Migration s'applique sur PG16 réel (rôle `nexus_migrator`, NOBYPASSRLS).
- RLS sur `sync_events` : tenant A ne voit pas tenant B.
- Désactivation/révocation de licence **ne bloque** pas l'accès aux données (test d'acceptation).

---

## C2 — MODULE LICENSES (cœur, `apps/api`)

### Fichiers à créer
- `apps/api/src/modules/licensing/licensing.controller.ts`
- `apps/api/src/modules/licensing/licensing.service.ts`
- `apps/api/src/modules/licensing/licensing.module.ts`

### Fichiers à modifier
- `apps/api/src/app.module.ts` : **ajout** du module licensing (additif).
- `apps/api/src/modules/tenants/tenants.service.ts` : **ajout** d'un hook minimal (licence liée au tenant) — **sans modifier** la logique existante.

### Dépendances
- Aucune nouvelle dépendance externe (réutilise Drizzle + NestJS existants).

### Risques
- Licence expirée ne doit **pas** couper l'accès (exigence du prompt) : logique « soft enforcement » (avertissement + limitation des actions **commerciales**, pas des données).
- Zone de sécurité : validation des entrées, audit des changements de licence.

### Tests de validation
- Création/activation/renouvellement/révocation de licence.
- **Test critique** : licence expirée/révoquée → données **accessibles**, export **possible**, restauration **possible**.
- SUPER_ADMIN peut gérer les licences ; tenant normal ne peut pas.

---

## C3 — MODULE SYNCHRONISATION BIDIRECTIONNELLE (cœur)

### Fichiers à créer
- `apps/api/src/modules/sync/sync.controller.ts` (API de synchronisation pour Edge Agent)
- `apps/api/src/modules/sync/sync.service.ts` (logique sync : push/pull, dédup, conflits)
- `apps/api/src/modules/sync/sync.module.ts`
- `apps/api/src/modules/sync/sync-conflict.policy.ts` (règles de résolution de conflits déterministes)

### Fichiers à modifier
- `apps/api/src/infra/outbox-relay.service.ts` : **ajout** d'un hook de synchronisation (relaier les événements outbox vers `sync_events`) — **sans modifier** la logique de relay existante.
- `apps/api/src/app.module.ts` : **ajout** du module sync.

### Dépendances
- `sync_events` (C1), Outbox existant, `packages/crypto-audit` (hash de contenu).

### Risques
- **Résolution de conflits** : doit être déterministe et documentée (merge par champ ou par priorité).
- **Idempotence** : même événement 2× = 1 application (via `idempotency_key`).
- **Sécurité** : mTLS/HMAC entre Edge Agent et cloud ; validation stricte des payloads.

### Tests de validation
- Push local→cloud, pull cloud→local.
- Déduplication : événement synchronisé 2× → 1 seule application.
- Conflit : deux modifications concurrentes → résolution déterministe + journal.
- Hors ligne : événements en tampon, reprise après reprise.
- Journal `sync_events` complet (horodatage, état, hash).

---

## C4 — EDGE AGENT (`apps/edge-agent`)

### Fichiers à créer
- `apps/edge-agent/package.json`, `tsconfig.json`
- `apps/edge-agent/src/main.ts` (serveur Node.js, LAN)
- `apps/edge-agent/src/buffer.ts` (tampon local chiffré — SQLite/LocalStorage)
- `apps/edge-agent/src/sync-client.ts` (HTTPS/mTLS vers le cloud)
- `apps/edge-agent/src/dedup.ts` (déduplication locale par `idempotency_key`)
- `apps/edge-agent/src/journal.ts` (journal local des synchronisations)
- `apps/edge-agent/README.md`

### Fichiers à modifier
- **Aucun** cœur. L'Edge Agent est un **nouveau service** autonome.

### Dépendances
- Node.js 22, `better-sqlite3` (tampon local), `@nexus-rh/shared-types` (contrats), `@nexus-rh/crypto-audit` (chiffrement tampon).

### Risques
- Déploiement sur site (Windows/Linux) : installateur + runbook.
- Rétention du tampon local (taille, rotation).
- Sécurité du tampon local chiffré (clé maîtresse).

### Tests de validation
- Démarrage standalone sur LAN.
- Tampon local chiffré écrit/lécture.
- Synchronisation vers cloud (push) + réception (pull).
- Coupure réseau → tampon accumule → reprise → retransmission ordre chronologique.
- Déduplication locale + distante.

---

## C5 — DEVICE GATEWAY + CONNECTEURS BIOMÉTRIQUES MULTI-MARQUES

### Fichiers à créer
- `apps/device-gateway/` (NestJS, service isolé) :
  - `package.json`, `tsconfig.json`, `src/main.ts`
  - `src/gateway.module.ts`
  - `src/endpoints/` (`/iclock/*` ZKTeco ADMS, `/isapi-hook/*` Hikvision, `/anviz/*`, `/suprema/*`)
- `packages/biometric-connectors/` :
  - `package.json`, `tsconfig.json`, `src/index.ts` (interface commune `BiometricConnector`)
  - `src/types.ts` (statut de maturité : SPECIFIED/SIMULATED/PROTOCOL_IMPLEMENTED/LAB_VALIDATED/PRODUCTION_CERTIFIED)
  - `src/zkteco/`, `src/hikvision/`, `src/anviz/`, `src/suprema/` (connecteurs)
  - `src/simulator/` (émulateur `[SIMULATION]` explicite)

### Fichiers à modifier
- **Aucun** cœur. Le Device Gateway est un **nouveau service** ; les connecteurs sont une **nouvelle bibliothèque**.
- `apps/api/src/app.module.ts` : **optionnel**, si le Device Gateway est fusionné dans l'API (décision D7). Par défaut : **service séparé**.

### Dépendances
- NestJS, `@nexus-rh/shared-types`, `@nexus-rh/crypto-audit`.
- Connecteur ZKTeco : protocole TCP 4370 / ADMS HTTPS.

### Risques
- **Statut de maturité** : aucun connecteur ne sera déclaré `PRODUCTION_CERTIFIED` sans matériel réel (règle du prompt). Le simulateur reste `[SIMULATION]`.
- Inter-opérabilité inter-marques : un gabarit n'est pas transférable entre marques (documenté).
- Injection/authentification des terminaux : validation stricte des trames.

### Tests de validation
- Interface commune : tous les connecteurs implémentent `BiometricConnector`.
- Simulateur : ingestion `[SIMULATION]` marquée, **ne alimente jamais** une paie réelle.
- Connecteur ZKTeco : trames protocolaires conformes (sans matériel, statut `PROTOCOL_IMPLEMENTED` max).
- **Test matériel** : passage à `LAB_VALIDATED`/`PRODUCTION_CERTIFIED` **uniquement** avec 12 tests sur vraie pointeuse (protocole d'homologation du plan biométrique).

---

## C6 — WORKER ASYNCHRONE (`apps/worker`)

### Fichiers à créer
- `apps/worker/` (NestJS) :
  - `package.json`, `tsconfig.json`, `src/main.ts`
  - `src/worker.module.ts`
  - `src/consumers/` (`attendance.consumer.ts`, `payroll.consumer.ts`, `document-pdf.consumer.ts`, `notification.consumer.ts`, `sync.consumer.ts`)

### Fichiers à modifier
- **Aucun** cœur. Nouveau service consommateur RabbitMQ.

### Dépendances
- `amqp-connection-manager`, `@nexus-rh/database`, `@nexus-rh/shared-types`.

### Risques
- Reprise après déconnexion (reconnection), DLQ, idempotence des consommateurs.

### Tests de validation
- Consommation d'événements réels via RabbitMQ (blocage sandbox : valider sur environnement autorisé).
- Reprise après déconnexion broker.
- DLQ après échecs répétés.

---

## C7 — PWA KIOSQUE (hors ligne, QR + PIN)

### Fichiers à créer
- `apps/kiosk/` (PWA Next.js) :
  - `package.json`, `next.config.ts`, `tsconfig.json`
  - `src/app/` (pointage QR+PIN, écran kiosque)
  - `src/lib/offline-store.ts` (IndexedDB chiffré, tampon hors ligne)
  - `public/manifest.webmanifest`, service worker

### Fichiers à modifier
- **Aucun** cœur. Le kiosk est une **nouvelle application** (ou sous-app dans `apps/web` — décision D8).

### Dépendances
- Next.js 16, PWA (service worker, IndexedDB).

### Risques
- Synchronisation des pointages hors ligne vers le cloud (via API cœur ou Edge Agent).
- Sécurité du tampon local IndexedDB (chiffrement).

### Tests de validation
- Pointage QR+PIN en ligne.
- **Hors ligne** : pointage tamponné localement, resynchronisé au retour.
- Déduplication des pointages hors ligne.

---

## C8 — INSTALATION + EXPLOITATION + SAUVEGARDE/RESTAURATION (LOCAL)

### Fichiers à créer
- `infra/scripts/install-local.sh` (installation Linux/Docker)
- `infra/scripts/install-local.ps1` (installation Windows)
- `infra/scripts/backup.sh` (sauvegarde PG + Redis + MinIO + config chiffrée)
- `infra/scripts/restore.sh` (restauration complète)
- `infra/scripts/healthcheck.sh` (supervision des services)
- `infra/scripts/update.sh` (mise à jour gérée, migrations additives)
- `docs/INSTALLATION_LOCAL.md`
- `docs/BACKUP_RESTAURATION.md`
- `docs/ADMINISTRATION.md`

### Fichiers à modifier
- **Aucun** cœur. Ajout de scripts et docs **nouveaux**.

### Dépendances
- Docker Compose (existant) ou installateur native ; `pg_dump`, `redis-cli BGSAVE`, `mc` (MinIO client).

### Risques
- Restauration partielle/corrompue : procédure de vérification d'intégrité (checksums).
- Chiffrement des sauvegardes (clés maîtresses).

### Tests de validation
- **Sauvegarde réelle** : PG, Redis, MinIO → archives vérifiées (SHA-256).
- **Restauration réelle** : restauration complète sur une base vide → données intactes + RLS fonctionnelle.
- Supervision : healthchecks détectent une panne.
- Mise à jour : migrations additives appliquées sans perte.

---

## C9 — DOCUMENTATION + NON-RÉGRESSION

### Fichiers à créer
- `docs/INSTALLATION_LOCAL.md`, `docs/BACKUP_RESTAURATION.md`, `docs/ADMINISTRATION.md`
- `docs/TESTS_REELS.md` (PV des tests réels : PASS/FAIL/BLOCKED + preuve)
- `docs/COMMERCIALISATION.md` (rapport de commercialisation)
- `ARCHITECTURE_LOCAL_CLOUD_HYBRIDE.md` (**fait — PHASE B**)

### Tests de validation (non-régression globale)
- Re-exécution de `pnpm verify` (56/56 existants) → **zéro régression**.
- Re-exécution des recettes réelles PG16 + Redis7.
- Tests des 3 modes (LOCAL, CLOUD, HYBRIDE) selon TEST_STRATEGY.md.
- Vérification des SHA-256 des migrations 0001–0004 (intactes).

---

## SYNTHÈSE — Fichiers à créer / à modifier

### Fichiers à CREER (principalement)
```
packages/database/migrations/0005_hybrid_sync_and_licensing.sql
apps/api/src/modules/licensing/{controller,service,module}.ts
apps/api/src/modules/sync/{controller,service,module,sync-conflict.policy}.ts
apps/edge-agent/**
apps/device-gateway/**
packages/biometric-connectors/**
apps/worker/**
apps/kiosk/**
infra/scripts/{install-local.sh,install-local.ps1,backup.sh,restore.sh,healthcheck.sh,update.sh}
docs/{INSTALLATION_LOCAL,BACKUP_RESTAURATION,ADMINISTRATION,TESTS_REELS,COMMERCIALISATION}.md
```

### Fichiers à MODIFIER (ajouts minimaux, additifs)
```
packages/database/src/schema.ts        (ajout des nouvelles tables Drizzle)
packages/database/src/index.ts         (ajout des types)
apps/api/src/app.module.ts             (ajout des modules licensing + sync)
apps/api/src/infra/outbox-relay.service.ts (hook sync additif, sans modifier la logique)
apps/api/src/modules/tenants/tenants.service.ts (hook licence minimal, additif)
```

### Migrations
- **À créer** : `0005_hybrid_sync_and_licensing.sql` (additive, rétrocompatible).
- **À ne JAMAIS modifier** : `0001`, `0002`, `0003`, `0004` (SHA-256 pincés, déjà validés).

### Dépendances externes à introduire (à valider)
- `better-sqlite3` (Edge Agent tampon local)
- `amqp-connection-manager` (Worker)
- Aucune modification des deps existantes du cœur.

### Risques principaux
1. Résolution de conflits sync — doit être déterministe et testée.
2. Idempotence généralisée — éviter les doublons.
3. Statut de maturité biométrique — jamais de fausse certification.
4. Licence ne bloque jamais l'accès aux données — test d'acceptation critique.
5. RabbitMQ/MinIO non validables en sandbox — tests à faire sur environnement autorisé.

### Ordre de réalisation
**C0 (fait) → C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 → C9**, chaque étape validée avant la suivante.

---

**Ce plan est présenté pour validation. Aucune implémentation, suppression, modification de migration existante, push, merge ou publication n'a été effectué. J'attends votre autorisation pour la PHASE D (implémentation).**
