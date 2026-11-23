# ARCHITECTURE TECHNIQUE — MODES LOCAL, CLOUD, HYBRIDE (PHASE B)

> **PHASE B — Architecture cible.** Document de proposition. **Aucune implémentation n'est effectuée durant cette phase.**
> Cœur réutilisé : NEXUS RH existant (M0–M2 + Vague 1/2). Aucun module existant n'est supprimé, remplacé ou reconstruit.

---

## 0. Principe fondamental : UN cœur, TROIS modes

NEXUS RH est **une seule application**, un **cœur métier unique** et une **architecture commune**. Les trois modes de déploiement (LOCAL, CLOUD, HYBRIDE) ne sont que des **combinaisons de composants et de profiles d'infra** autour du même cœur, **sans duplication de code métier**.

La propriété clés qui rend cela possible **déjà aujourd'hui** :

1. **Architecture hexagonale** (ports swappables) — `apps/api/src/infra/ports.ts` :
   - `CacheLockPort` (Redis ou adaptateur local)
   - `MessageBusPort` (RabbitMQ ou adaptateur local)
   - `ObjectStoragePort` (S3/MinIO ou adaptateur local de fichiers)
   → **Le même code métier** s'exécute sur Redis, sur un cache local, sur RabbitMQ ou sur un bus en mémoire.
2. **Profiles d'infra** — `INFRA_PROFILE` : `sandbox` / `docker` / `production` (`apps/api/src/config/app-config.ts`), avec garde-fous de sécurité stricts (pas de sandbox en production, clés obligatoires, TLS PG).
3. **Base unique** — PostgreSQL 16 + FORCE RLS + schéma Drizzle + migrations additives, **identique** dans tous les modes (même schéma, mêmes règles).
4. **Outbox transactionnel** — `outbox_events` + `OutboxRelayService` : file d'attente d'événements fiables **déjà existante**, base de la synchronisation et de la reprise.

---

## 1. Composants du système global

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          COEUR COMMU N EXUS RH (existant)                    │
│   API NestJS + modules métier (IAM, RBAC, tenants, organization, hr,       │
│   audit, health)  +  packages/database + packages/crypto-audit +           │
│   packages/shared-types.  Même code, même schéma, mêmes règles RLS.         │
└─────────────────────────────────────────────────────────────────────────────┘
        │            │               │               │
   CacheLock    MessageBus     ObjectStorage     NexusDatabase
   Port          Port            Port             (PG16 + RLS)
        │            │               │               │
   Redis /       RabbitMQ /      S3 / MinIO /      PostgreSQL 16
   cache local   bus local       stockage local    (ou PG managé)
```

### 1.1 Composants existants (cœur — à conserver tel quel)

| Composant | Rôle | Mode(s) |
|---|---|---|
| `apps/api` (NestJS) | API cœur métier, auth, MFA, RBAC, audit, outbox | tous |
| `apps/web` (Next.js) | Application SaaS multi-entreprises, ESS, admin | CLOUD, HYBRIDE |
| `packages/database` | Schéma Drizzle, migrations, RLS, client PG/PGlite, outbox relay | tous |
| `packages/crypto-audit` | Chiffrement AES-256-GCM, signature QR, audit chaîné SHA-256 | tous |
| `packages/shared-types` | Contrats TypeScript, RBAC, schémas Zod | tous |
| `infra/docker/docker-compose.yml` | PG16, Redis7, RabbitMQ, MinIO + healthchecks | LOCAL, HYBRIDE |
| `infra/scripts/check-governance.mjs` | Contrôles de gouvernance (CI) | tous |

### 1.2 Composants à ajouter (NOUVEAUX — modules optionnels, sans reconstruire le cœur)

| Composant | Rôle | Mode(s) | Statut actuel |
|---|---|---|---|
| `apps/edge-agent` | Passerelle locale de site (Node.js/TS) : tampon local chiffré + synchronisation LAN→cloud | LOCAL, HYBRIDE | **Spécifié, non codé** |
| `apps/device-gateway` | Passerelle d'ingestion biométrique isolée (protocoles fabricants) | LOCAL, HYBRIDE, CLOUD | **Spécifié, non codé** |
| `apps/worker` | Consommateurs asynchrones RabbitMQ (GTA, paie, PDF, notifications, **synchronisation**) | CLOUD, HYBRIDE | **Spécifié, non codé** |
| `apps/kiosk` | PWA kiosque/tablette/mobile (QR+PIN, **hors ligne**) | tous | **Spécifié, non codé** (PWA planifiée dans web) |
| `packages/biometric-connectors` | Interface commune + connecteurs par fabricant (ZKTeco, Hikvision, Anviz, Suprema, …) | LOCAL, HYBRIDE, CLOUD | **Spécifié, non codé** |
| Module `licenses` (dans `apps/api`) | Gestion commerciale des licences LOCAL/CLOUD/HYBRIDE | tous | **Non implémenté** |
| Module `sync` (dans `apps/api` + edge-agent) | Synchronisation bidirectionnelle locale↔cloud | LOCAL, HYBRIDE | **Seul le flux cloud unidirectionnel (outbox) existe** |

---

## 2. MODE CLOUD (SaaS managé)

### 2.1 Architecture
- **Cœur NEXUS RH** sur une plateforme cloud (PG managé, Redis managé, RabbitMQ managé ou containerisé, S3 managé).
- **Multi-entreprises (tenants)** : un tenant = une entreprise cliente. Isolation par **RLS FORCE** + double verrou applicatif (guards NestJS + `SET LOCAL app.current_tenant_id`).
- **Multi-sites** : une entreprise possède plusieurs sites (fuseaux `Africa/Kinshasa`, `Africa/Lubumbashi`).
- **Administration centrale** : SUPER_ADMIN avec délégation bornée (≤72 h, zéro accès silencieux).
- **Abaonnements** : `tenant_subscriptions` (existant) + module **licences**.
- **API externe** sécurisée (Ed25519, mTLS optionnel, rate-limits).

### 2.2 Flux
```
Pointeuse Cloud Push ─┐
Kiosque PWA (online) ─┼─► Device Gateway ─► API cœur ─► PG16 (RLS) ─► Outbox ─► RabbitMQ ─► Workers
                     │                              │                                       (paie, PDF, notif)
                     └─ Edge Agent (site connecté)─┘
```

### 2.3 Validation requise
- PG16 réel + RLS ✅ (déjà prouvé — Vague 3, 10/10)
- Redis 7 réel ✅ (déjà prouvé — Vague 3, 11/11)
- RabbitMQ réel (broker) — **à valider** (blocage sandbox : thoas/hex.pm)
- MinIO/S3 réel — **à valider** (blocage sandbox : binaire)
- Évolutivité horizontale : PG (PG managé), Redis (cluster), RabbitMQ (cluster), API (multi-instances via réplicas).

---

## 3. MODE LOCAL (sur site, hors ligne capable)

### 3.1 Architecture
- **NEXUS RH complet sur un serveur sur site** (Windows Server ou Linux Server), **sans dépendance à un cloud**.
- **Stack locale** : PostgreSQL 16 (serveur local), Redis 7 (local), RabbitMQ (local), MinIO (local) — **via Docker Compose sur site** (config `docker` existante) **ou installation native**.
- **Mode sans cloud** : l'API cœur + les bases tournent **entièrement localement** ; l'application web est servie sur le LAN.
- **Sauvegardes locales** : backups planifiés (PG `pg_dump`/WAL-arch, Redis AOF, MinIO, fichiers de config chiffrés) + restauration.
- **Surveillance** : healthchecks + agents de supervision (status des services, disque, bases).
- **Mises à jour** : flux de mise à jour gérés (migrations additives, rétrocompatibles expand/contract).

### 3.2 Flux
```
Pointeuse LAN ─► Device Gateway (local) ─► API cœur (local) ─► PG16 (local, RLS) ─► Outbox ─► RabbitMQ (local) ─► Workers
                     ▲                                   │
                     │                                   └─► MinIO (local)
                     └─ Edge Agent (si pointeuse sans Cloud Push)
```

### 3.3 Validation requise
- Installation réproducible sur Linux/Windows (Docker Compose **ou** installeur).
- Démarrage autonome + santé des services.
- **Hors ligne** : l'app fonctionne sans Internet (cœur + bases locales).
- Sauvegarde + restauration complète **réelles** (PG, Redis, MinIO).
- **Licence LOCAL** (module licences) validée.

---

## 4. MODE HYBRIDE (LAN local ↔ Cloud, synchronisation bidirectionnelle)

### 4.1 Architecture
- Combinaison : un **site local (LOCAL)** synchronise avec le **cloud central (CLOUD)**.
- **Edge Agent** sur le site local :
  - Tampon local chiffré (SQLite/enregistrement local) des pointages et événements en cas de coupure.
  - **File d'attente locale** + retransmission vers le cloud dès reprise.
  - **Réception** des commandes/mises à jour du cloud vers le site.
- **Synchronisation bidirectionnelle** :
  - **Local → Cloud** : pointages, attendances, événements métier (idempotents, dédupliqués par `idempotency_key`).
  - **Cloud → Local** : configuration, règles, mises à jour, licences.
- **Résolution de conflits** : règles explicites par type d'entité (merge déterministe, priorité configurable, journal des conflits).
- **Reprise automatique** : reprise après coupure réseau/courant (file locale + outbox cloud).
- **Journal des synchronisations** : horodatage, état (en attente/synchronisé/échoué/conflit), hash de contenu.

### 4.2 Flux
```
   LOCAL (site)                                      CLOUD (central)
┌──────────────────────────────┐            ┌──────────────────────────────┐
│ Pointeuse LAN                │            │ Pointeuse Cloud Push         │
│   │                          │            │   │                          │
│   ▼                          │            │   ▼                          │
│ Device Gateway (local)       │            │ Device Gateway (cloud)       │
│   │                          │            │   │                          │
│   ▼                          │            │   ▼                          │
│ API cœur (local, PG/Redis/   │  SYNC      │ API cœur (cloud, PG/Redis/   │
│   RabbitMQ/MinIO locals)    │◄─────────►│   RabbitMQ/MinIO cloud)     │
│   │                          │ bidirectionnelle │                          │
│   ▼                          │            │   ▼                          │
│ Edge Agent                   │            │ Outbox / Workers            │
│   ├─ tampon local chiffré     │            │   ├─ synchronisation local  │
│   ├─ dedup + idempotence      │            │   └─ résolution conflits   │
│   └─ journal sync             │            │                             │
│ Hors ligne : fonctionne       │            │                             │
└──────────────────────────────┘            └──────────────────────────────┘
```

### 4.3 Validation requise
- **Synchronisation bidirectionnelle réelle** (deux instances : local + cloud).
- **Déduplication** : même événement synchronisé 2× = 1 seule application.
- **Résolution de conflits** : scénarios tests (deux modifications concurrentes).
- **Hors ligne + reprise** : coupure réseau, retransmission, ordre chronologique.
- **Journal des synchronisations** complet et auditable.
- **Licence HYBRIDE** validée.

---

## 5. TABLE DE CORRESPONDANCE — Ce qui existe vs ce qui est ajouté

| Capabilité requise (PROMPT) | Existant | À ajouter | Mode |
|---|---|---|---|
| Cœur métier unique | ✅ | — | tous |
| Isolation multi-tenant RLS | ✅ prouvé | — | CLOUD/HYBRIDE |
| PG16 + Redis7 + RabbitMQ + MinIO | ✅ config + adapters | — | tous |
| File d'attente d'événements | ✅ Outbox (cloud unidirectionnel) | Workers consommateurs | CLOUD/HYBRIDE |
| Synchronisation **bidirectionnelle** | ❌ (unidirectionnel) | Module `sync` + Edge Agent | LOCAL/HYBRIDE |
| Edge Agent | ❌ | `apps/edge-agent` | LOCAL/HYBRIDE |
| Device Gateway | ❌ | `apps/device-gateway` | tous |
| Connecteurs biométriques multi-marques | ❌ (framework planifié) | `packages/biometric-connectors` | tous |
| QR/PIN/mobile | ✅ badges QR+PIN | PWA kiosque hors ligne | tous |
| Gestion des **licences** | ❌ (`tenant_subscriptions` seul) | Module `licenses` | tous |
| Installation + exploitation **locale** | ❌ (compose seulement) | Installateur + runbooks | LOCAL |
| **Sauvegarde + restauration** | ❌ | Scripts + procédures | tous |
| **Fonctionnement hors connexion** | ❌ (cœur local possible) | Kiosque hors ligne + Edge Agent tampon | LOCAL/HYBRIDE |

---

## 6. STRATÉGIE DE RÉUTILISATION (zéro reconstruction)

1. **Le cœur NEXUS RH n'est pas modifié** : les trois modes partagent `apps/api`, `packages/*`, le schéma PG16 et les politiques RLS.
2. **Les adapters hexagonaux** permettent de passer de Redis/RabbitMQ/S3 à des implémentations locales **sans changer le code métier**.
3. **L'Outbox existant** est la base de la file d'attente d'événements et de la reprise ; le module `sync` s'y appuie (pas de duplication).
4. **Les migrations 0001–0004 sont intouchables** ; toute extension (licences, synchronisation) utilise des **migrations additives** (nouveaux fichiers `0005_*`, rétrocompatibles).
5. **Chaque composant ajouté** est un **nouveau module**, testé indépendamment, sans retrait d'existant.

---

## 7. DÉCISIONS D'ARCHITECTURE (soumises à validation)

- **D1 — Un schéma PG unique** pour les 3 modes (pas de schéma LOCAL distinct).
- **D2 — L'Edge Agent est un composant Node.js léger**, tampon local chiffré + HTTPS/mTLS vers le cloud.
- **D3 — La synchronisation utilise l'Outbox + un journal dédié** `sync_events` (à créer en migration additive).
- **D4 — La déduplication par `idempotency_key`** (déjà présente en base pour le badge QR) est généralisée à tous les événements synchronisés.
- **D5 — Les licences sont gérées côté cœur** (`apps/api`) avec schéma additive, **sans jamais bloquer** l'accès aux données, la restauration ou l'export (exigence du prompt).
- **D6 — Chaque mode a sa propre configuration d'infra** (`docker` pour LOCAL, `production` pour CLOUD, `docker`+sync pour HYBRIDE) via `INFRA_PROFILE`.

**Ce document est une proposition. Aucun code n'a été implémenté. J'attends l'autorisation pour la PHASE C (plan de modifications détaillé).**
