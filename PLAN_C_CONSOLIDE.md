# PLAN C CONSOLIDÉ — NEXUS RH (PHASE C REVUE)

> **PHASE C — Révision consolidée du plan de modifications.** Document **strictement documentaire**.
> **AUCUN CODE, AUCUNE MIGRATION, AUCUNE CONFIG, AUCUN REFACTORING N'EST IMPLÉMENTÉ.**
> Ce document intègre l'ensemble des conclusions du rapport d'audit technique (Phases B et C) et des problèmes **P1 à P9**.
> **Ceci n'est pas une autorisation d'implémentation. La Phase D est suspendue jusqu'à autorisation explicite du propriétaire.**

**Statut des livrables :** révision documentaire. **Aucune fonctionnalité prévue n'est présentée comme opérationnelle.**

**Statuts utilisés dans ce document :**
- **EXISTANT ET VÉRIFIÉ** — présent dans le code, testé/prouvé.
- **PARTIELLEMENT IMPLÉMENTÉ** — présent mais incomplet ou limité.
- **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** — spécifié, pas de code.
- **À CONCEVOIR** — nécessite une conception avant implémentation.
- **À IMPLÉMENTER** — planifié, pas commencé.
- **À VALIDER SUR MATÉRIEL RÉEL** — nécessite une preuve matérielle.

---

## 1. RÉSUMÉ EXECUTIV

NEXUS RH possède un **cœur applicatif solide et réel** : architecture hexagonale (ports/adapters), PostgreSQL 16 + RLS FORCE, auth JWT EdDSA, MFA TOTP, chiffrement AES-256-GCM, audit chaîné, badges QR+PIN, abonnements, outbox transactionnel. Ce cœur est **déjà prouvé** sur PG16 réel et Redis 7 réel (Vague 3).

La transition vers les **trois modes LOCAL / CLOUD / HYBRIDE** est réalisable **sans reconstruire** le cœur, mais nécessite des **corrections architecturales importantes** identifiées par l'audit :

- **P1** : aucun profil LOCAL sans dépendance distante (Redis/RabbitMQ/S3 obligatoires hors sandbox).
- **P2** : l'authentification nécessite Redis + PG reachables (pas d'auth hors ligne).
- **P3** : la suspension/révocation d'un tenant **bloque l'accès aux données** (viole la règle des licences non-bloquantes).
- **P4** : pas de rotation de clés cryptographiques.
- **P5** : déduplication non généralisée (idempotence uniquement sur badges).
- **P6** : pas de sécurité Edge Agent / tampon local chiffré.
- **P7** : pas de synchronisation bidirectionnelle (seul outbox cloud unidirectionnel).
- **P8** : pas d'installation/exploitation/backup-restore Windows/Linux.
- **P9** : RabbitMQ et MinIO non validables dans le sandbox.

**Principle directeur :** un **seul cœur**, une **seule logique métier**, une **architecture commune** aux trois modes, sans sacrifier les fonctionnalités validées ni la sécurité.

**Condition de passage à la Phase D :** validation explicite de ce plan par le propriétaire, avec décisions sur les points ouverts (section 15).

---

## 2. ÉTAT RÉEL DE L'ARCHITECTURE EXISTANTE

### 2.1 Fondations **EXISTANTES ET VÉRIFIÉES**

| Fondation | Preuve (fichier/interface) | Statut |
|---|---|---|
| Architecture hexagonale (ports swappables) | `apps/api/src/infra/ports.ts` — `CacheLockPort`, `MessageBusPort`, `ObjectStoragePort` | **EXISTANT ET VÉRIFIÉ** |
| Adapters Redis / RabbitMQ / S3 | `apps/api/src/infra/adapters.ts` — `RedisCacheLockAdapter`, `RabbitMqBusAdapter`, `S3ObjectStorageAdapter` | **EXISTANT ET VÉRIFIÉ** |
| Adapters sandbox (en mémoire + stockage local) | `SandboxMemoryCacheLockAdapter`, `SandboxMessageBusAdapter`, `SandboxObjectStorageAdapter` | **EXISTANT ET VÉRIFIÉ** |
| Sélection d'adapters par profil | `apps/api/src/infra/infra.module.ts` (`INFRA_PROFILE === 'sandbox'`) | **EXISTANT ET VÉRIFIÉ** |
| Profils d'infra | `packages/shared-types/src/constants.ts` — `['production','docker','sandbox']` | **EXISTANT ET VÉRIFIÉ** |
| PostgreSQL 16 + RLS FORCE (23 tables) | `packages/database/migrations/0001–0004*.sql`, `schema.ts` | **EXISTANT ET VÉRIFIÉ** (Vague 3 : 10/10) |
| PGlite (sandbox) | `packages/database/src/client.ts` | **EXISTANT ET VÉRIFIÉ** |
| Auth JWT EdDSA + sessions | `apps/api/src/common/auth.guard.ts`, `iam.controller.ts` | **EXISTANT ET VÉRIFIÉ** |
| MFA TOTP | `packages/crypto-audit/src/totp.ts`, auth guard | **EXISTANT ET VÉRIFIÉ** |
| Chiffrement AES-256-GCM (enveloppe) | `packages/crypto-audit/src/envelope.ts` | **EXISTANT ET VÉRIFIÉ** |
| Audit chaîné SHA-256 | `packages/crypto-audit/src/audit-chain.ts` | **EXISTANT ET VÉRIFIÉ** |
| Badges QR signés + PIN Argon2id | `packages/crypto-audit/src/badge-qr.ts`, `hr.service.ts` | **EXISTANT ET VÉRIFIÉ** |
| Abonnements / plans tarifaires | `subscription_plans`, `tenant_subscriptions` (`schema.ts`) | **EXISTANT ET VÉRIFIÉ** |
| Outbox transactionnel + relay | `outbox_events`, `outbox-relay.service.ts` | **EXISTANT ET VÉRIFIÉ** (flux cloud unidirectionnel) |
| Redis 7 réel | `test-redis-lua.mjs` | **EXISTANT ET VÉRIFIÉ** (11/11) |
| Isolation tenant/site | RLS `tenant_isolation_*`, table `sites`, `membershipSiteScopes` | **EXISTANT ET VÉRIFIÉ** |

### 2.2 Fonctions **DOCUMENTÉES MAIS NON IMPLÉMENTÉES**

| Fonction | Statut |
|---|---|
| Edge Agent | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** |
| Device Gateway | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** |
| Worker asynchrone (consommateurs) | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** |
| Kiosque PWA hors ligne | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** (badges QR+PIN existants, app kiosque absente) |
| Connecteurs biométriques (ZKTeco/Hikvision/Anviz/Suprema) | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** (statut `SPECIFIED`) |
| Module licences (`licenses` table) | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** |
| Synchronisation bidirectionnelle (`sync_events`) | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** |
| Moteur GTA / Paie / Attendance | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** (pas de table/code) |
| Installateur Windows/Linux | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** (seul `docker-compose.yml`) |
| Scripts sauvegarde/restauration | **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** |

---

## 3. ARCHITECTURE CIBLE — LOCAL / CLOUD / HYBRIDE

### 3.1 Principe : UN cœur, TROIS modes
Les trois modes partagent `apps/api`, `packages/*`, le schéma PG16 et les politiques RLS. Les modes sont des **combinaisons de composants et de profiles d'infra** autour du même cœur, **sans duplication de code métier**.

### 3.2 MODE LOCAL
**Objectif :** NEXUS RH sur un serveur sur site (Windows/Linux), **fonctionnant même sans Internet**.

**Prévoir :**
- PostgreSQL 16 **local**.
- **Cache local persistant** (Redis local **ou** adapter de cache persistant — SQLite/fichier).
- **Bus de messages local persistant** (RabbitMQ local **ou** bus local persistant — SQLite outbox/file sur disque).
- **Stockage documentaire local** (MinIO local **ou** stockage fichiers local).
- **Authentification locale** indépendante d'Internet (P2).
- **Sessions locales** persistantes.
- **Pointage autonome** (kiosque hors ligne).
- **Connecteurs biométriques locaux**.
- **Sauvegardes et restaurations locales** (P8).
- **Journalisation et audit**.
- **Synchronisation différée** si un Cloud est associé.

**Règle (P1) :** **Aucune dépendance à un Redis/RabbitMQ/S3 distant ne doit empêcher le fonctionnement LOCAL.** Le choix entre services installés localement et adapters alternatifs est documenté (§4.1).

### 3.3 MODE CLOUD
**Objectif :** plateforme SaaS multi-entreprises, multi-sites.

**Prévoir :** infrastructure centralisée (PG, Redis, RabbitMQ, S3/MinIO managés) ; isolation stricte des entreprises (RLS FORCE + double verrou) ; gestion des abonnements **et licences** (P3) ; sécurité centralisée (RBAC, MFA, rate-limits, CSRF, CSP) ; sauvegardes automatiques ; supervision et haute disponibilité ; gestion des utilisateurs et permissions.

### 3.4 MODE HYBRIDE
**Objectif :** infrastructure locale autonome connectée à une plateforme Cloud.

**Prévoir :** serveur local autonome ; plateforme Cloud centrale ; **Edge Agent sécurisé** (P6) ; **synchronisation bidirectionnelle** (P7) ; **tampon local persistant et chiffré** ; **reprise automatique après coupure** ; **déduplication** (P5) ; **gestion des conflits** ; **accusés de réception** ; **journal de synchronisation**.

**Règle :** **Une coupure Internet ne doit jamais empêcher les opérations RH locales.**

---

## 4. CORRECTION DES PROBLÈMES P1 À P9

### 4.1 P1 — Profil LOCAL sans dépendance distante
**Conception :**
- **Créer un profil `local`** explicite (ajouter à `INFRA_PROFILES`), ou faire du `docker` un profil autonome sur site.
- **Adapters de substitution persistants** pour remplacer Redis/RabbitMQ/S3 distants :
  - **Cache** : `LocalPersistentCacheAdapter` (SQLite WAL ou fichier) — remplissant `CacheLockPort`.
  - **Bus** : `LocalPersistentBusAdapter` (SQLite outbox / file durable sur disque) — remplissant `MessageBusPort`.
  - **Stockage** : `LocalFileObjectStorageAdapter` — remplissant `ObjectStoragePort`.
- **Exigences :** persistance après redémarrage ; reprise après redémarrage ; cohérence (lecture après écriture garantie par WAL/durabilité).
- **Sécurité :** les adapters locaux sont **opt-in explicite** ; les garde-fous existants (pas de sandbox en production, clés obligatoires) sont **préservés**.

**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

### 4.2 P2 — Authentification hors ligne
**Conception :**
- **Vérification locale des JWT EdDSA** (crypto local, indépendante d'Internet).
- **Gestion locale des sessions** persistantes (base locale + cache local).
- **Révocation locale persistante** (cache local persistant au lieu de Redis distant ; en mode CLOUD, Redis central).
- **Refresh tokens** renouvelables quand le serveur local est reachable.
- **Protection contre le rejeu** (jti + fenêtre d'expiration + révocation).
- **Expiration et renouvellement** locaux.
- **Gestion des utilisateurs et permissions** locales.
- **Révocation des appareils perdus** (révocation de session persistante).
- **Préserver le fail-closed** pour les contrôles de sécurité, **sans dépendance distante** : en LOCAL, la révocation est vérifiée dans le cache local persistant ; en CLOUD, dans Redis.

**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

### 4.3 P3 — Licences non bloquantes (exigence fondamentale)
**Conception — séparer TROIS niveaux de droits :**
1. **Droits d'accès aux données** : consultation, export, sauvegarde, restauration, récupération, historiques de continuité. **JAMAS bloqués** par une licence.
2. **Droits d'utilisation des fonctionnalités** : accès aux modules métier selon la souscription.
3. **Limitations commerciales** liées à la licence (nombre de sites/utilisateurs/employés, nouvelles souscriptions).

**Règle absolue :** une licence expirée/suspendue/révoquée **ne doit jamais empêcher** consultation, export, sauvegarde, restauration, récupération, accès aux historiques.

**Correction du code :** **ne pas confondre `tenant.status` avec le statut de licence.** Découpler le blocage d'accès (`auth.guard.ts` ligne 233) de la licence :
- **Accès aux données** : **jamais** bloqué par licence.
- **Actions commerciales** : limitées/signalées (soft enforcement — avertissement + limitation, **pas de perte de données**).

**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

### 4.4 P4 — Rotation des clés cryptographiques
**Conception :**
- **Versionnement des clés** : table `key_versions` (kid, purpose, status [ACTIVE|ROTATING|RETIRED|REVOKED], created_at).
- **Identifiants de clés** : `kid` lié aux enveloppes (`EnvelopeContext.keyRef` déjà existant).
- **Gestion KEK/DEK** : Master KEK (existant) → Tenant KEK (HKDF, existant) → DEK (existant) ; ajout de la notion de **version** dans la dérivation (`nexus-rh-tenant-kek:v{version}:...`).
- **Rotation progressive** : nouvelle DEK versionnée ; ré-encryption progressive des données.
- **Ré-encryption des données** : parcours des enveloppes, re-encryption avec la nouvelle DEK.
- **Conservation temporaire des anciennes clés** : clés `ROTATING`/`RETIRED` conservées jusqu'à fin de ré-encryption + délai.
- **Révocation contrôlée** : clés `REVOKED` → déchiffrement refusé ; données déjà ré-encryptées accessibles.
- **Procédure de récupération** : documentation de la rotation, point d'arrêt/reprise.
- **Tests de non-perte de données** : après rotation, toutes les données déchiffrables, accès maintenu.

**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

### 4.5 P5 — Déduplication générale
**Conception :**
- **Mécanisme d'idempotence global** : chaque événement synchronisé porte une **clé unique** (`idempotency_key = SHA-256(tenantId|entityType|entityId|operation|hashPayload)` ou clé fournie).
- **UNIQUE** dans `sync_events` ; **`ON CONFLICT DO NOTHING`** → un événement reçu plusieurs fois est appliqué **une seule fois**.
- Généralisation du mécanisme existant (badges) à tous les événements (pointages, présence, etc.).

**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

### 4.6 P6 — Sécurité Edge Agent
**Conception :**
- **Identité unique** de chaque agent (certificat / clé deppareil).
- **Authentification mutuelle** (mTLS) ou mécanisme cryptographique équivalent (HMAC avec clé partagée dérivée).
- **Gestion des certificats et secrets** : stockage sécurisé, rotation.
- **Révocation des agents** : liste de révocation persistante.
- **Tampon local chiffré** : chiffrement AES-256-GCM (réutiliser `envelope.ts`), clé maîtresse locale protégée.
- **Protection contre les rejeux** : idempotence + accusés.
- **Accusés de réception** : le cloud accuse réception (ack) avec hash ; l'agent retire du tampon **après ack**.
- **Reprise automatique** : tampon persistant sur disque, curseur durable.

**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

### 4.7 P7 — Synchronisation bidirectionnelle (intégrer la conception de l'audit)
Intégrer **intégralement** la conception de synchronisation (détaillée en §6). Distinguer :
- **Données immuables** : pointages, événements de présence, événements de sécurité, consentements → **append-only, pas d'écrasement, pas de LWW**.
- **Données modifiables** : horaires, profils, configurations, règles RH, paramètres d'entreprise → **versionnement + règles de résolution de conflits**.

**Règle :** **ne pas utiliser systématiquement Last-Write-Wins pour les pointages ou événements sensibles.**

**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

### 4.8 P8 — Installation et exploitation
**Conception :** stratégie complète (§10).
**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

### 4.9 P9 — Validation RabbitMQ et MinIO
**Conception :** documenter les validations à effectuer dans un **environnement autorisé** (accès hex.pm/binaires ou Docker).
**Règle :** **ne jamais** considérer ces composants comme certifiés sur une simple compilation ou un test simulé.
**Statut :** **À VALIDER SUR MATÉRIEL RÉEL / ENVIERNMENT AUTORISÉ.**

---

## 5. ANALYSE DES ÉCARTS

| Exigence | Existant | Écart | Statut cible |
|---|---|---|---|
| Cœur métier unique | ✅ | — | EXISTANT |
| Isolation multi-tenant RLS | ✅ prouvé | — | EXISTANT |
| PG16 + Redis7 + RabbitMQ + MinIO | ✅ adapters | — | EXISTANT |
| Profil LOCAL sans dépendance distante | ❌ (P1) | Adapters persistants locaux | À IMPLÉMENTER |
| Auth hors ligne | ❌ (P2) | Vérification JWT + révocation locale | À IMPLÉMENTER |
| Licences non-bloquantes | ❌ (P3) | Séparation droits/accès | À IMPLÉMENTER |
| Rotation des clés | ❌ (P4) | key_versions + rotation | À IMPLÉMENTER |
| Déduplication générale | ❌ (P5) | Idempotence globale | À IMPLÉMENTER |
| Sécurité Edge Agent | ❌ (P6) | mTLS + tampon chiffré | À IMPLÉMENTER |
| Synchronisation bidirectionnelle | ❌ (P7) | Design complet §6 | À IMPLÉMENTER |
| Install Windows/Linux | ❌ (P8) | Installateurs + runbooks | À IMPLÉMENTER |
| Backup/restore | ❌ (P8) | Scripts + procédures | À IMPLÉMENTER |
| RabbitMQ/MinIO certifiés | ❌ (P9) | Validation env autorisé | À VALIDER |
| Biométrie multi-marques | ❌ spécifié | Connecteurs + maturité | À IMPLÉMENTER / À VALIDER |
| Kiosque hors ligne | ❌ spécifié | PWA + auth hors ligne | À IMPLÉMENTER |
| GTA / Paie / Attendance | ❌ spécifié | Moteurs | À IMPLÉMENTER |

---

## 6. ARCHITECTURE DE SYNCHRONISATION (P7)

### 6.1 Distinction fondamentale
- **Événements immuables** (pointages, présence, sécurité, consentements) : **append-only**, **pas de conflit**, **pas de LWW**.
- **Données modifiables** (horaires, profils, configs, règles RH) : **versionnement + conflits**.

### 6.2 Versionnement des enregistrements
- Table `sync_record_versions` (`entity_type`, `entity_id`, `version`, `payload jsonb`, `tenant_id`, `site_id`, `created_at`, `origin`, `hash`).
- Chaque modification incrémente `version` ; chaque version porte `hash = SHA-256(payload canonical)`.
- Record courant → version active ; historique conservé pour résolution/audit.

### 6.3 Identifiants globaux et idempotence
- **ID global** = UUIDv7 (réutiliser `packages/crypto-audit/src/uuidv7.ts`) — **universel local↔cloud**.
- **Clé idempotence** = `SHA-256(tenantId|entityType|entityId|operation|hashPayload)` ou clé fournie ; **UNIQUE** dans `sync_events`.
- **Règle :** même événement 2× → **1 seule application** (`ON CONFLICT DO NOTHING`).

### 6.4 Gestion des suppressions
- **Suppression tombeuse** : `deleted_at` + `sync_deleted=true` (pas de suppression physique si synchronisation).
- **Propagation** : l'événement de suppression est synchronisé comme événement immuable ; le destinataire applique la tombée après validation d'ordre.
- **Rétention configurable** : ne pas propager les suppressions avant X jours.

### 6.5 Synchronisation incrémentale
- **`sync_cursors`** (`site_id`, `direction`, `last_ack_id`, `last_ack_at`, `in_flight`, `state`).
- **Push** : événements `created_at > cursor` ou `version > cursor`.
- **Pull** : cloud renvoie les événements cloud→local non acquitté.
- **Incrémental** par fenêtre temporelle + par version.

### 6.6 Curseurs de reprise
- Reprise depuis le curseur acquitté ; **événements non-acquittés restent en attente** (durables dans `sync_events`).

### 6.7 Détection des conflits
- **Déterministe par hash** : deux versions divergentes d'un enregistrement (hash différent, versions croisées) → `state=CONFLICT`.
- **Immuables** : aucun conflit (deux mêmes pointages = dédupe).
- **Modifiables** : conflit si `(tenant_id, entity_type, entity_id, version)` collide avec contenu divergent.

### 6.8 Résolution déterministe
- **Règles par type d'entité** (configurables, versionnées) :
  - **Merge par champ** (union des champs modifiés ; conflit si divergence → priorité par règle).
  - **Last-write-wins par horodatage** **uniquement pour données modifiables non sensibles**.
  - **Priorité par site/origine** (configurable).
- **Résolution loggée** dans `sync_events.conflict_resolution` (JSON : règle, horodatage, hash avant/après).
- **Toujours déterministe** : même input → même résolution.

### 6.9 Journal d'audit (append-only)
- **`sync_events`** : direction, entity_type, entity_id, idempotency_key, state, hash_payload, payload, attempts, last_error, synced_at, created_at, conflict_resolution.
- **Append-only / chainable** (réutiliser `audit-chain.ts`).

### 6.10 Accusés de réception et protection contre rejeux
- Cloud accuse (ack) avec hash ; agent retire du tampon **après ack**.
- **Rejeux** : `idempotency_key` déjà `SYNCED` rejoué → alerte, aucune application.
- **Doublons** : `ON CONFLICT DO NOTHING`.

### 6.11 Reprise après coupure Internet/électrique
- **Tampon local persistant chiffré** (Edge Agent) : événements écrits avant envoi, survivent aux coupures.
- **Curseur durable** : avancement après ack cloud.
- **Reprise automatique** : retour → retrait en ordre chronologique (horodatage fiable), dédupe.
- **Électricité** : tampon sur disque (SQLite/WAL) ; PG/Redis/RabbitMQ sur site avec AOF/WAL.

---

## 7. ARCHITECTURE DE SÉCURITÉ

| Aspect | Conception | Statut |
|---|---|---|
| **Auth Edge Agents** (P6) | mTLS ou HMAC ; identité unique ; révocation | À IMPLÉMENTER |
| **Chiffrement tampons locaux** (P6) | AES-256-GCM (enveloppe) ; clé maîtresse locale protégée | À IMPLÉMENTER |
| **Gestion et rotation clés** (P4) | `key_versions`, versionnement, rotation progressive, ré-encryption | À IMPLÉMENTER |
| **mTLS / équivalent** (P6) | mTLS Edge↔cloud ; en CLOUD, TLS 1.3 + Ed25519 (existant) | À IMPLÉMENTER (Edge) / EXISTANT (cloud) |
| **Isolation entreprises** | RLS FORCE (existant) + double verrou | EXISTANT ET VÉRIFIÉ |
| **Isolation sites** | `sites` + `membershipSiteScopes` + RLS (existant) | EXISTANT ET VÉRIFIÉ |
| **RLS nouvelles tables** | `sync_events`, `sync_record_versions`, `sync_cursors`, `licenses`, `key_versions` → politiques RLS tenant | À IMPLÉMENTER |
| **Protection données RH personnelles** | AES-256-GCM enveloppe (existant), blind index, consentements (existant) | EXISTANT ET VÉRIFIÉ + À IMPLÉMENTER (rotation) |

**Préserver :** fail-closed, MFA, rate-limits, CSRF, CSP, TLS PG, audit chaîné — sans dégradation.

---

## 8. GESTION DES LICENCES (P3)

### 8.1 Trois niveaux de droits (séparation absolue)
1. **Accès aux données** : consultation, export, sauvegarde, restauration, récupération, historiques. **JAMAIS bloqué.**
2. **Utilisation des fonctionnalités** : modules métier selon souscription.
3. **Limitations commerciales** : sites/utilisateurs/employés, nouvelles souscriptions.

### 8.2 Règles commerciales par mode
- **LOCAL** : licence LOCAL (permet l'exploitation sur site, hors ligne). Ne bloque jamais la récupération.
- **CLOUD** : licence CLOUD (SaaS, multi-entreprises). Ne bloque jamais la récupération.
- **HYBRIDE** : licence HYBRIDE (locale + cloud). Ne bloque jamais la récupération.

### 8.3 Comportement d'une licence expirée/suspendue/révoquée
- **Consultation OK, export OK, sauvegarde OK, restauration OK, récupération OK, historiques OK.**
- **Limitations** : signalement + limitation des **actions commerciales** (ajouts, nouvelles souscriptions) ; **aucune perte de données**.
- **Ne pas confondre** `tenant.status` (accès) et statut de licence (commercial).

**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

---

## 9. ARCHITECTURE BIOMÉTRIQUE

### 9.1 Progression de maturité (obligatoire)
1. **SPECIFIED** — protocole documenté.
2. **SIMULATION** — simulateur fonctionnel, clairement identifié `[SIMULATION]`.
3. **PROTOCOL_IMPLEMENTED** — connecteur implémenté.
4. **LAB_VALIDATED** — tests sur matériel réel.
5. **PRODUCTION_CERTIFIED** — validation complète sur matériel réel.

### 9.2 Marques
ZKTeco, Hikvision, Anviz, Suprema, **autres via architecture extensible** (`packages/biometric-connectors`).

### 9.3 Modes de pointage
Biométrie ; empreinte digitale ; reconnaissance faciale (équipements + autorisations) ; badge RFID ; QR Code ; PIN ; tablette ; smartphone ; kiosque.

### 9.4 Règles absolues
- **Un simulateur ne doit jamais alimenter une paie réelle.**
- **Aucune certification matérielle sans preuves d'essais réels** (12 tests sur vraie pointeuse).
- **Statut affiché** explicite ; aucun passage à `PRODUCTION_CERTIFIED` sans preuve.

**Statut :** **DOCUMENTÉ MAIS NON IMPLÉMENTÉ** (connecteurs) / **À VALIDER SUR MATÉRIEL RÉEL** (certification).

---

## 10. SAUVEGARDE ET RESTAURATION (P8)

### 10.1 Politique complète
- **Sauvegarde PostgreSQL** : `pg_dump` / WAL-arch (point-in-time recovery).
- **Sauvegarde fichiers documentaires** : S3/MinIO/stockage local.
- **Sauvegarde paramètres** : config chiffrée, clés.
- **Protection des clés de chiffrement** : sauvegarde KEK maîtresse hors site (chiffrée).
- **Contrôle SHA-256** : chaque archive vérifiée par hash.
- **Sauvegardes locales** (LOCAL) + **Cloud** (CLOUD) + **hors site** (réplication).
- **Restauration sur environnement vierge** testée.
- **Tests périodiques de restauration**.
- **Plan de reprise après sinistre**.

### 10.2 Règle
**La restauration des données doit rester possible même si une licence est expirée** (P3).

**Statut :** **À CONCEVOIR / À IMPLÉMENTER.**

---

## 11. PLAN D'IMPLÉMENTATION PROGRESSIF (C0 → C10)

> **Proposition à examiner — pas une autorisation de commencer.**

### C0 — Validation de l'architecture et des exigences
- **Objectif :** valider le plan consolidé.
- **Périmètre :** revue, décisions ouvertes (§15).
- **Fichiers :** documents.
- **Dépendances :** —
- **Risques :** —
- **Mesures de sécurité :** —
- **Tests :** revue.
- **Critères d'acceptation :** autorisation du propriétaire.
- **Conditions d'arrêt/retour arrière :** —

### C1 — Profil LOCAL et adapters persistants (P1)
- **Objectif :** cœur fonctionnel sans dépendance distante.
- **Périmètre :** profil `local` ; `LocalPersistentCacheAdapter`, `LocalPersistentBusAdapter`, `LocalFileObjectStorageAdapter`.
- **Fichiers à créer :** adapters dans `apps/api/src/infra/` ; profil dans `shared-types`.
- **Fichiers à modifier :** `infra.module.ts` (ajout du profil, additif), `constants.ts`.
- **Dépendances :** `better-sqlite3` (ou équivalent).
- **Risques :** dégradation du fail-closed ; mitigation = adapters opt-in explicites.
- **Mesures de sécurité :** garde-fous préservés.
- **Tests unitaires/intégration :** adapters locaux persistants (écriture/lecture/redémarrage).
- **Critères d'acceptation :** cœur fonctionnel sans Redis/RabbitMQ/S3 distants.
- **Conditions d'arrêt :** si fail-closed dégradé → retour arrière.

### C2 — Authentification et sessions hors ligne (P2)
- **Objectif :** auth locale indépendante d'Internet.
- **Périmètre :** vérification JWT locale, révocation cache local persistant, refresh tokens, révocation appareils.
- **Fichiers à créer :** service auth locale.
- **Fichiers à modifier :** `auth.guard.ts` (ajout du chemin local, **sans modifier** le chemin cloud), `iam.*`.
- **Dépendances :** adapters C1.
- **Risques :** contournement révocation ; mitigation = cache local persistant + tests.
- **Mesures de sécurité :** fail-closed maintenu (local).
- **Tests :** auth hors ligne, révocation persistante, rejeu.
- **Critères d'acceptation :** consultation/export hors ligne OK.
- **Conditions d'arrêt :** si fail-closed dégradé.

### C3 — Séparation licences et accès aux données (P3)
- **Objectif :** licences non-bloquantes.
- **Périmètre :** `licenses`, `license_entitlements` ; module licensing ; découplage `tenant.status`/licence.
- **Fichiers à créer :** migration `0005_hybrid_sync_and_licensing.sql` ; module `apps/api/src/modules/licensing/`.
- **Fichiers à modifier :** `app.module.ts` (additif), `tenants.service.ts` (hook minimal), **`auth.guard.ts` (découplage — modifikation justifiée et minimale).**
- **Dépendances :** —
- **Risques :** blocage non intentionnel ; mitigation = tests d'acceptation no-block.
- **Mesures de sécurité :** audit des changements de licence.
- **Tests :** licence expirée/suspendue/révoquée → données accessibles/export/backup/restore.
- **Critères d'acceptation :** aucune interdiction d'accès aux données.
- **Conditions d'arrêt :** si données bloquées.

### C4 — Sécurité Edge Agent (P6)
- **Objectif :** agent sécurisé.
- **Périmètre :** identité, mTLS/HMAC, révocation, tampon chiffré, accusés.
- **Fichiers à créer :** `apps/edge-agent/`.
- **Dépendances :** `better-sqlite3`, `@nexus-rh/crypto-audit`.
- **Risques :** compromission tampon ; mitigation = chiffrement + révocation.
- **Mesures de sécurité :** mTLS, HMAC.
- **Tests :** auth agent, tampon chiffré, révocation, rejeu.
- **Critères d'acceptation :** agent non authentifié refusé.
- **Conditions d'arrêt :** —

### C5 — Synchronisation bidirectionnelle (P7)
- **Objectif :** sync fiable (§6).
- **Périmètre :** `sync_events`, `sync_record_versions`, `sync_cursors`, module sync, résolution conflits.
- **Fichiers à créer :** migration (si distincte), module `apps/api/src/modules/sync/`.
- **Fichiers à modifier :** `outbox-relay.service.ts` (hook additif), `app.module.ts`.
- **Dépendances :** C4, crypto-audit.
- **Risques :** conflits, reprise ; mitigation = règles déterministes + tests.
- **Mesures de sécurité :** mTLS/HMAC, RLS `sync_events`.
- **Tests :** push/pull, dédupe, conflit, reprise, rejeu, journal.
- **Critères d'acceptation :** 2× = 1 application ; résolution déterministe.
- **Conditions d'arrêt :** conflit non résolu déterministement.

### C6 — Kiosque hors ligne
- **Objectif :** pointage QR+PIN hors ligne.
- **Périmètre :** `apps/kiosk/`, auth hors ligne, horodatage fiable, dédupe, sync post-reconnexion, gestion terminal perdu.
- **Fichiers à créer :** `apps/kiosk/`.
- **Dépendances :** Next.js 16, PWA, C2/C5.
- **Risques :** double pointage, horodatage ; mitigation = idempotence + horodatage monotone/NTP.
- **Mesures de sécurité :** tampon IndexedDB chiffré, révocation.
- **Tests :** pointage hors ligne, double pointage refusé, sync post-reconnexion.
- **Critères d'acceptation :** fonctionne sans Internet.
- **Conditions d'arrêt :** —

### C7 — Connecteurs biométriques
- **Objectif :** framework + connecteur ZKTeco.
- **Périmètre :** `packages/biometric-connectors/`, `apps/device-gateway/`.
- **Fichiers à créer :** librairie + service.
- **Dépendances :** NestJS, `@nexus-rh/*`.
- **Risques :** fausse certification ; mitigation = statut de maturité, `[SIMULATION]`.
- **Mesures de sécurité :** validation trames.
- **Tests :** interface commune, simulateur `[SIMULATION]`, trames ZKTeco (max `PROTOCOL_IMPLEMENTED` sans matériel).
- **Critères d'acceptation :** simulateur ne alimente jamais paie réelle.
- **Conditions d'arrêt :** —

### C8 — Sauvegarde et restauration
- **Objectif :** stratégie complète (§10).
- **Périmètre :** `infra/scripts/backup.sh`, `restore.sh`.
- **Fichiers à créer :** scripts.
- **Dépendances :** `pg_dump`, `redis-cli`, `mc`.
- **Risques :** corruption, clés ; mitigation = SHA-256, chiffrement.
- **Mesures de sécurité :** clés protégées.
- **Tests :** backup réel SHA-256, restauration sur base vierge.
- **Critères d'acceptation :** restauration testée, possible même licence expirée.
- **Conditions d'arrêt :** —

### C9 — Installation Windows/Linux et exploitation
- **Objectif :** installation + runbooks.
- **Périmètre :** `infra/scripts/install-local.sh`, `install-local.ps1`, `healthcheck.sh`, `update.sh`, docs.
- **Fichiers à créer :** scripts + docs.
- **Dépendances :** Docker Compose ou installateur native.
- **Risques :** —
- **Mesures de sécurité :** —
- **Tests :** installation Linux/Windows, démarrage, supervision.
- **Critères d'acceptation :** installation réproducible.
- **Conditions d'arrêt :** —

### C10 — Validation intégrale LOCAL/CLOUD/HYBRIDE
- **Objectif :** preuve des trois modes.
- **Périmètre :** tests d'acceptation (§12) sur les trois modes.
- **Fichiers :** tests.
- **Dépendances :** tous les C1–C9.
- **Risques :** —
- **Mesures de sécurité :** —
- **Tests :** §12.
- **Critères d'acceptation :** 11 tests obligatoires + tests spécifiques passent.
- **Conditions d'arrêt :** —

---

## 12. TESTS D'ACCEPTATION

### 12.1 Les 11 tests obligatoires (rapport d'audit)
1. **Profil local sans broker** : app fonctionne **sans Redis/RabbitMQ/S3 distants**.
2. **Auth hors ligne** : authentifié peut consulter/exporter **sans Internet**.
3. **Licence non-bloquante** : expirée/suspendue/révoquée → **consultation/export/backup/restore/récupération OK** ; seules actions commerciales limitées.
4. **Rotation des clés** : rotation DEK → données ré-encryptées, accès maintenu.
5. **Synchronisation** : push/pull bidirectionnel ; dédupe ; conflit résolu déterministe ; reprise ; rejeux ignorés ; journal vérifiable.
6. **Immutables vs modifiables** : pointage immutable → pas de conflit ; horaire modifié → versionnement + conflit.
7. **Edge Agent** : auth mTLS/HMAC ; tampon chiffré résistant coupure ; accusés ; reprise.
8. **Kiosque** : auth hors ligne ; double pointage refusé ; horodatage fiable ; sync post-reconnexion ; terminal perdu révoqué.
9. **Biométrie** : simulateur `[SIMULATION]` ne alimente jamais paie réelle ; connecteur protocolaire (max `PROTOCOL_IMPLEMENTED`) ; certification **uniquement** après 12 tests matériels.
10. **Sauvegarde/restauration** : backup réel SHA-256 ; restauration complète sur base vierge → données + RLS ; reprise après sinistre.
11. **Non-régression** : `pnpm verify` intact ; PG16/Redis7 réels revalidés ; SHA-256 migrations 0001–0004 intacts.

### 12.2 Tests spécifiques supplémentaires
- Coupure électrique.
- Perte de connexion Internet.
- Redémarrage du serveur local.
- Redémarrage de l'Edge Agent.
- Synchronisation interrompue.
- Événements dupliqués.
- Conflits entre deux sites.
- Terminal biométrique indisponible.
- Restauration après corruption.
- Licence expirée.
- Révocation d'un appareil.
- Isolation entre entreprises.
- Isolation entre sites.

**Règle :** **Aucun test simulé ne doit être présenté comme une validation matérielle.**

---

## 13. ANALYSE DES RISQUES

| Risque | Niveau | Mitigation |
|---|---|---|
| Refactor garde-fou Redis/RabbitMQ obligatoires → dégradation fail-closed | Moyen | Adapters opt-in explicites ; garde-fous préservés ; tests sécurité |
| Résolution de conflits non déterministe | Élevé | Règles versionnées+testées ; journal conflits |
| Horodatage fiable hors ligne | Moyen | Horodatage monotone + NTP au retour ; dédupe hash |
| Rotation clés → accès données existantes | Moyen | Rotation progressive ; tests non-perte |
| Licence soft enforcement contourné | Moyen | Tests no-block ; audit code paths |
| Fausse certification biométrique | Élevé | Statut affiché ; `[SIMULATION]` ; 12 tests matériels |
| RabbitMQ/MinIO non validables sandbox | Élevé | Validation env autorisé |
| Complexité synchronisation | Élevé | Incrémental C5a→C5b ; tests deux instances |
| Perte historique Git | Critique | Commit `bcbf6ba` + archives ; versionnement systématique |

---

## 14. DÉPENDANCES TECHNIQUES

| Dépendance | Statut | Usage |
|---|---|---|
| PostgreSQL 16 | EXISTANT | tous |
| Redis 7 | EXISTANT | CLOUD/HYBRIDE/LOCAL (ou adapter local) |
| RabbitMQ | EXISTANT (config) | CLOUD/HYBRIDE/LOCAL (ou bus local) ; **à valider (P9)** |
| MinIO/S3 | EXISTANT (adapter) | tous (ou stockage local) ; **à valider (P9)** |
| Docker Compose | EXISTANT | LOCAL/HYBRIDE |
| `better-sqlite3` (ou équivalent) | **À ajouter** | tampon Edge Agent / adapters locaux |
| `amqp-connection-manager` | **À ajouter** | Worker |
| Next.js 16 / PWA | EXISTANT (web) / **À ajouter** (kiosk) | kiosque |
| Aucune modification des deps du cœur | — | préserver |

---

## 15. CONDITIONS DE PASSAGE À LA PHASE D

La Phase D ne peut commencer **qu'après** :
1. **Validation explicite** de ce plan consolidé par le propriétaire.
2. **Décisions** sur les points ouverts :
   - Profil `local` : nouveau profil vs adaptation du profil `docker`.
   - Adapters locaux persistants : `better-sqlite3` vs autre.
   - Découplage `auth.guard.ts` (C3) : acceptation de la modification minimale justifiée.
   - Découpage C0–C10 : acceptation ou ajustement.
   - Validation RabbitMQ/MinIO : environnement autorisé disponible.
3. **Re-capture Git** si nécessaire avant toute implémentation.
4. **Autorisation écrite** du propriétaire.

**À ce stade : ARRÊT. Phase D suspendue. Attendre autorisation.**

---

## 16. MATRICE DE TRAÇABILITÉ

| Exigence | Statut | Solution | Implémentation | Test | Preuve attendue |
|---|---|---|---|---|---|
| Cœur métier unique | EXISTANT | `apps/api`, `packages/*` | — | non-régression | `pnpm verify` |
| Isolation multi-tenant RLS | EXISTANT ET VÉRIFIÉ | RLS FORCE | — | RLS | Vague 3 10/10 |
| Profil LOCAL sans distant | À IMPLÉMENTER | P1 adapters persistants | C1 | test 1 | démarrage sans Redis/RabbitMQ distants |
| Auth hors ligne | À IMPLÉMENTER | P2 auth locale | C2 | test 2 | consultation hors ligne |
| Licences non-bloquantes | À IMPLÉMENTER | P3 séparation | C3 | test 3 | données accessibles licence expirée |
| Rotation clés | À IMPLÉMENTER | P4 key_versions | C3 | test 4 | ré-encryption + accès |
| Déduplication globale | À IMPLÉMENTER | P5 idempotence | C5 | test 5 | 2×=1 |
| Sécurité Edge Agent | À IMPLÉMENTER | P6 mTLS/tampons | C4 | test 7 | agent non authentifié refusé |
| Synchronisation bidirectionnelle | À IMPLÉMENTER | P7 design §6 | C5 | test 5,6 | push/pull/conflit/reprise |
| Kiosque hors ligne | À IMPLÉMENTER | C6 | C6 | test 8 | pointage hors ligne |
| Connecteurs biométriques | DOCUMENTÉ / À VALIDER | §9 | C7 | test 9 | `[SIMULATION]`, trames, 12 tests |
| Install Windows/Linux | À IMPLÉMENTER | P8 | C9 | tests C9 | installation réproducible |
| Backup/restore | À IMPLÉMENTER | §10 | C8 | test 10 | restore base vierge |
| RabbitMQ/MinIO certifiés | À VALIDER | P9 | — | — | validation env autorisé |
| GTA/Paie/Attendance | DOCUMENTÉ | — | hors scope Phase C | — | — |

---

## 17. CONTRÔLE FINAL OBLIGATOIRE

- **Cohérence exigences ↔ solutions :** ✅ chaque exigence P1–P9 a une solution.
- **Aucune fonctionnalité existante inutilement remplacée :** ✅ réutilisation des fondations (ports, adapters, RLS, auth, enveloppe, audit).
- **Trois modes partagent le même cœur :** ✅.
- **Mode LOCAL fonctionne conceptuellement sans Internet :** ✅ (avec adapters persistants — P1).
- **Mode HYBRIDE permet une synchronisation fiable :** ✅ (§6).
- **Licence ne bloque jamais la récupération :** ✅ (P3, test 3).
- **Mécanismes de sécurité restent robustes :** ✅ (fail-closed préservé, mTLS, RLS).
- **Critères d'acceptation mesurables :** ✅ (§12).

**Contradictions techniques exposées (non masquées) :**
1. Le cœur actuel **exige Redis+RabbitMQ+S3** hors sandbox (P1) — la Phase B initiale sous-estimait cette contrainte ; correcté par C1.
2. L'auth actuel **dépend de Redis** (P2) — l'auth hors ligne nécessite un cache local persistant ; correcté par C2.
3. La suspension de tenant **bloque l'accès** (P3) — **incompompatible** avec la règle des licences non-bloquantes ; nécessite un découplage (C3) **modification minimale justifiée de `auth.guard.ts`**.
