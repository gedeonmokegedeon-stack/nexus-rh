# ARCHITECTURE TECHNIQUE — NEXUS RH

## 1. Principes directeurs d'architecture

L'architecture de **NEXUS RH** est conçue selon le style **Monolithe Modulaire Évolutif + Services Spécialisés Isolés** au sein d'un **monorepo TypeScript strict**, appliquant l'architecture hexagonale (*Ports & Adapters*).

Ce choix offre le meilleur équilibre pour un produit SaaS commercialisable :

- **Rapidité et cohérence de développement** (types partagés de bout en bout, transactions ACID propres, zéro complexité inutile de 20 micro-services prématurés).
- **Isolation physique des charges critiques** : la passerelle d'ingestion biométrique (`device-gateway`) et les traitements lourds asynchrones (`worker` : paie, calcul des temps, PDF, synchronisation appareils) sont séparés de l'API utilisateur (`api`) afin qu'un pic de 50 000 pointages à 08h00 ou la génération de 5 000 bulletins ne ralentisse jamais l'interface RH.
- **Découplage total des fabricants biométriques** : chaque marque de pointeuse vit dans un adaptateur isolé respectant un contrat unique.
- **Portabilité d'infrastructure** : exécution native sur **PostgreSQL + Redis + RabbitMQ + S3** en production et via Docker Compose, tout en disposant d'adaptateurs de développement permettant de tester et prévisualiser l'application dans des environnements contraints (tels que le sandbox Arena).

---

## 2. Vue d'ensemble du système

```text
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          UTILISATEURS, TERMINAUX & TIERS                            │
│                                                                                     │
│  [Navigateur RH/Paie/DG]  [Smartphone PWA Agent]  [Tablette PWA Kiosque QR/PIN]     │
│  [Pointeuses Cloud Push: ZKTeco ADMS | Hikvision ISUP/HTTP | Anviz | Suprema]       │
│  [Site LAN Isolé: Pointeuses LAN <──> Nexus Edge Agent (Tampon chiffré SQLite)]     │
│  [ERP / Comptabilité / BI externes via API v1 & Webhooks signés]                    │
└──────────────┬────────────────────────┬───────────────────────────┬─────────────────┘
               │ HTTPS (TLS 1.3)        │ HTTPS / mTLS / Push       │ HTTPS (API Keys)
               ▼                        ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                     COUCHE EDGE : WAF / REVERSE PROXY / TLS / CDN                   │
└──────────────┬────────────────────────┬───────────────────────────┬─────────────────┘
               │                        │                           │
               ▼                        ▼                           │
┌──────────────────────────┐  ┌─────────────────────────┐           │
│ apps/web & apps/kiosk    │  │ apps/device-gateway     │           │
│ Next.js 16 + React 19    │  │ NestJS 12 (Isolé)       │           │
│ - Portail SaaS Multi-RH  │  │ - Auth par terminal     │           │
│ - Portail Agent (ESS)    │  │ - Connecteurs par marque│           │
│ - PWA Kiosque Offline    │  │ - Ingestion idempotente │           │
│   (SW + IndexedDB AES)   │  │ - File commandes sync   │           │
└──────────────┬───────────┘  └────────────┬────────────┘           │
               │ /api/v1 (Proxy/HTTPS)     │                        │
               ▼                           │                        │
┌──────────────────────────┐               │                        │
│ apps/api                 │◄──────────────┼────────────────────────┘
│ NestJS 12 (Cœur Métier)  │               │
│ - Auth / MFA / RBAC / SoD│               │
│ - Tenants & Multi-Sites  │               │
│ - Agents, Contrats, QR   │               │
│ - GTA, Congés, Horaires  │               │
│ - Paramétrage & Paie RDC │               │
│ - Rapports, Audit, Ext.  │               │
└──────┬───────┬───────┬───┘               │
       │       │       │                   │
       │       │       ▼                   ▼
       │       │  ┌──────────────────────────────────────────┐
       │       │  │ RabbitMQ (AMQP 0.9.1 + Exchanges + DLQ)  │
       │       │  │ - attendance.ingested                    │
       │       │  │ - device.commands / device.sync          │
       │       │  │ - payroll.calculate / payslip.render     │
       │       │  │ - documents.generate / notifications.send│
       │       │  └────────────────────┬─────────────────────┘
       │       │                       │
       │       │                       ▼
       │       │  ┌──────────────────────────────────────────┐
       │       │  │ apps/worker (NestJS 12 Consumers)        │
       │       │  │ - AttendanceEngine (shifts, retards, HS) │
       │       │  │ - PayrollEngine (paie RDC paramétrable)  │
       │       │  │ - PdfGenerator (bulletins, badges, états)│
       │       │  │ - DeviceSyncOrchestrator & Notifier      │
       │       │  └────────┬───────────┬───────────┬─────────┘
       │       │           │           │           │
       ▼       ▼           ▼           ▼           ▼
┌───────────────────┐ ┌──────────────────┐ ┌─────────────────────────┐
│ PostgreSQL 16/17  │ │ Redis 7          │ │ Stockage Compatible S3  │
│ - Multi-tenant RLS│ │ - Cache tenant   │ │ (S3 / R2 / MinIO)       │
│ - Partitionnement │ │ - Rate limiting  │ │ - Dossiers RH chiffrés  │
│ - Outbox Pattern  │ │ - Révocation JWT │ │ - Bulletins PDF signés  │
│ - Audit SHA-256   │ │ - Verrous Paie   │ │ - États & Sauvegardes   │
└───────────────────┘ └──────────────────┘ └─────────────────────────┘
```

---

## 3. Pile technologique et versions cibles recommandées

Les versions ci-dessous ont été vérifiées sur le registre officiel `npmjs.org` lors de l'audit du 17 novembre 2026 et choisies pour leur stabilité mutuelle :

| Composant | Technologie & version recommandée | Justification technique |
|---|---|---|
| **Runtime serveur** | **Node.js 22.x LTS** (v22.22+ vérifié) | Stabilité LTS, support natif WebCrypto, performances V8 optimisées. |
| **Langage** | **TypeScript ~6.0.x** (v6.0.3) | Compatibilité native vérifiée avec les métadonnées de décorateurs (`emitDecoratorMetadata`) de NestJS 12. *(TypeScript 7.0 sera évalué uniquement lorsque l'écosystème décorateurs NestJS le certifiera pleinement.)* |
| **Gestionnaire monorepo** | **pnpm** (via Corepack) + **Turborepo 2.x** | Dédoublonnage disque strict, isolation des dépendances, cache de build incrémental. |
| **Frontend Web & PWA** | **Next.js 16.x** (App Router) + **React 19.x** | Rendu hybride SSR/RSC performant, optimisation réseau, routage moderne, support PWA natif (manifeste + Service Worker). |
| **UI & Formulaires** | **Tailwind CSS + composants Radix/shadcn + React Hook Form + Zod** | Accessibilité WCAG AA, cohérence visuelle professionnelle, validation partagée front/back. |
| **Backend API / Gateway / Worker** | **NestJS 12.x** | Architecture modulaire stricte, injection de dépendances, Guards/Interceptors idéaux pour multi-tenancy, RBAC et audit, génération OpenAPI automatique. |
| **Base de données** | **PostgreSQL 16 ou 17** | Transactions ACID, Row-Level Security (RLS) natif, type `NUMERIC` exact, `JSONB`, partitionnement déclaratif des pointages. |
| **ORM & Migrations** | **Drizzle ORM 0.45.x + `pg` 8.x** | SQL explicite et maîtrisé (essentiel pour RLS, partitionnement et requêtes analytiques de paie), zéro binaire propriétaire externe, compatibilité transparente avec PostgreSQL et PGlite (pour tests et sandbox). |
| **Arithmétique financière** | **decimal.js** | Calculs décimaux à précision arbitraire et modes d'arrondi comptables explicites (`ROUND_HALF_UP`, etc.). |
| **Cache & verrous** | **Redis 7.x** (`ioredis`) | Verrous distribués sur cycles de paie, anti-rebond rapide, rate limiting par IP/tenant/appareil, liste de révocation des sessions. |
| **Bus de messages** | **RabbitMQ 3.13 / 4.x** (`amqplib`) | Routage par *topic exchanges*, persistance disque des messages, acquittement manuel (`ack`/`nack`), files de reprise à délai et Dead-Letter Queues (DLQ). |
| **Stockage objet** | **API S3** (`@aws-sdk/client-s3`) | Indépendance fournisseur : fonctionne à l'identique sur AWS S3, Cloudflare R2, Scaleway Object Storage ou MinIO auto-hébergé. |
| **Génération PDF & Excel** | **PDFKit / React-PDF** + **ExcelJS** + **qrcode** | Génération serveur rapide et déterministe de bulletins de paie, badges CR80 QR et états Excel sans nécessiter un navigateur Chromium lourd en mémoire. |
| **Sécurité cryptographique** | **Argon2id** (mots de passe & PIN) + **Node `crypto` / OpenSSL 3** | Chiffrement AES-256-GCM par enveloppe, signatures HMAC-SHA256 / Ed25519 pour QR Codes, jetons terminaux et chaîne d'audit. |
| **Validation & Contrats** | **Zod + OpenAPI 3.1** | Validation stricte de 100 % des entrées API, webhooks et trames appareils. |
| **Observabilité** | **Pino (logs JSON structurés) + OpenTelemetry + Prometheus** | Corrélation bout en bout (`request_id`, `tenant_id`, `device_id`, `job_id`), métriques métier et alertes. |

---

## 4. Organisation détaillée du monorepo

### 4.1 Applications (`apps/`)

1. **`apps/web`** — Portail SaaS principal (Next.js) :
   - Console Super-Admin plateforme (tenants, plans, monitoring global, modèles réglementaires).
   - Espace Entreprise (organisation multi-sites, RH, contrats, badges, parc biométrique, GTA, congés, paie RDC, rapports, sécurité/audit).
   - Espace Self-Service Agent (ESS) responsive et installable en PWA sur smartphone (planning, pointages, congés, bulletins, QR Code personnel).
2. **`apps/kiosk`** — PWA Tablette de Pointage (Next.js / PWA dédiée) :
   - Interface plein écran ultra-rapide conçue pour tablettes d'accueil/guérite.
   - Enrôlement sécurisé de la tablette par code d'appairage à usage unique rattaché à un établissement précis.
   - Scan QR Code (caméra WebRTC / `BarcodeDetector` + fallback WASM) et clavier PIN tactile à disposition aléatoire optionnelle.
   - Cache local chiffré (WebCrypto AES-GCM dans IndexedDB) des seuls hachages/identifiants de badges autorisés du site (zéro donnée salariale ou RH sensible sur la tablette) et file locale des pointages hors ligne avec synchronisation en arrière-plan.
3. **`apps/api`** — API Métier Principale (NestJS) :
   - Organisée en modules domaine découplés : `iam`, `tenants`, `organization`, `employees`, `contracts`, `badges`, `biometrics-admin`, `schedules`, `attendance`, `leaves`, `payroll-config`, `payroll-runs`, `documents`, `reports`, `notifications`, `audit`, `billing`, `external-api`.
4. **`apps/device-gateway`** — Passerelle d'Ingestion des Appareils (NestJS) :
   - Surface réseau minimale et durcie dédiée aux terminaux physiques, aux kiosques PWA et aux agents Edge.
   - Expose les endpoints protocolaires isolés (ex. `/iclock/*` pour ZKTeco ADMS, `/isapi-hook/*` pour Hikvision, `/anviz/*`, `/suprema/*`, `/edge/v1/*`, `/kiosk/v1/*`).
   - Authentifie l'appareil, persiste immédiatement la trame brute idempotente, publie `attendance.ingested` dans RabbitMQ (via *Transactional Outbox*) et répond en quelques millisecondes.
5. **`apps/worker`** — Moteur de Traitements Asynchrones (NestJS) :
   - Consomme les files RabbitMQ avec concurrence contrôlée, idempotence stricte, tentatives exponentielles et envoi en DLQ en cas d'échec persistant.
   - Exécute : qualification des pointages, recalcul des journées de présence, acquisition mensuelle des congés, calcul des lots de paie, génération de lots de bulletins PDF/badges/exports, orchestration des commandes vers les terminaux, envoi des notifications et alertes d'échéance.
6. **`apps/edge-agent`** — Passerelle Locale de Site (Node.js) :
   - Binaire/service léger déployable en Docker ou service Windows/Linux sur un site client disposant de pointeuses uniquement LAN (sans mode Cloud Push) ou d'une connexion Internet très instable.
   - Communication exclusivement **sortante** en HTTPS (TLS 1.3 + jeton d'agent rotatif / mTLS) vers `device-gateway` : aucune ouverture de port entrant sur le routeur du client.
   - Tampon local chiffré garantissant zéro perte pendant les coupures Internet.

### 4.2 Bibliothèques internes (`packages/`)

- **`packages/shared-types`** : DTOs, énumérations, schémas Zod, codes d'erreur normalisés.
- **`packages/database`** : schéma Drizzle, client transactionnel tenant-aware (injectant `SET LOCAL app.current_tenant_id`), migrations SQL versionnées et politiques RLS.
- **`packages/attendance-engine`** : bibliothèque pure (sans I/O) calculant l'appariement entrée/sortie, les vacations de nuit, les retards, les pauses, les heures supplémentaires ventilées et les absences.
- **`packages/payroll-engine`** : bibliothèque pure, déterministe et sans effet de bord prenant en entrée un contexte d'agent + un jeu de règles versionné (`PayrollRuleSet`) + les variables du mois, et retournant les lignes de paie exactes ainsi que l'arbre complet d'explication (`CalculationTrace`).
- **`packages/biometric-connectors`** : contrat `IBiometricConnector`, registre des fabricants, matrice de maturité, connecteurs indépendants (`zkteco/`, `hikvision/`, `anviz/`, `suprema/`, `generic/`) et simulateur de protocole strictement cloisonné (`simulator/`).
- **`packages/crypto-audit`** : chiffrement d'enveloppe AES-256-GCM, gestion des clés par tenant, signature/vérification des QR Codes, hachage Argon2id et calcul de chaîne SHA-256 d'audit.
- **`packages/ui`** : composants d'interface réutilisables, tableaux de données, badges de statut et système de design.

---

## 5. Architecture SaaS multi-entreprises et multi-sites

### 5.1 Modèle d'isolation retenu : Défense en profondeur (Applicatif + RLS PostgreSQL)

Chaque entreprise cliente correspond à un **Tenant** (`tenant_id` UUID). Toutes les tables métier portent obligatoirement `tenant_id NOT NULL` et une politique **PostgreSQL Row-Level Security (`FORCE ROW LEVEL SECURITY`)**.

Flux d'exécution de chaque requête authentifiée :

1. Le `AuthGuard` vérifie le JWT (ou la clé API / le jeton d'appareil) et extrait le `tenant_id` signé côté serveur (**jamais** lu depuis le corps de la requête ou un paramètre URL manipulable).
2. Le `TenantContextInterceptor` ouvre un contexte `AsyncLocalStorage` et configure toute transaction PostgreSQL avec :
   ```sql
   SET LOCAL app.current_tenant_id = '<uuid-du-tenant>';
   SET LOCAL app.current_user_id   = '<uuid-utilisateur>';
   ```
3. PostgreSQL applique automatiquement la politique `USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)` sur `SELECT`, `INSERT`, `UPDATE` et `DELETE`. Même en cas de bug d'oubli d'un `WHERE tenant_id = ...` dans une requête applicative, la base refuse tout accès croisé.
4. À l'intérieur du tenant, le `SiteScopeGuard` filtre en outre par `site_id` selon les établissements autorisés pour l'utilisateur (ex. un chef d'agence à Lubumbashi ne voit que les agents et pointages de l'établissement de Lubumbashi, tandis que la DRH du siège à Kinshasa consolide tous les sites).
5. **Évolutivité Grands Comptes** : comme toutes les connexions passent par un résolveur de tenant, un client bancaire ou minier exigeant contractuellement une base PostgreSQL dédiée pourra être routé vers une instance isolée sans réécrire la logique métier.

### 5.2 Gestion multi-fuseaux horaires (spécificité RDC)

- Stockage systématique des instants en `TIMESTAMPTZ` (UTC) dans PostgreSQL.
- Conservation sur chaque établissement et chaque terminal du fuseau IANA (`Africa/Kinshasa` UTC+1 ou `Africa/Lubumbashi` UTC+2, ou tout autre fuseau futur).
- Conservation sur chaque événement de pointage de : `occurred_at_utc`, `device_local_time`, `site_timezone` et `received_at_utc` (permettant de détecter un terminal dont l'horloge est déréglée ou un pointage transmis en différé après coupure réseau).

---

## 6. Architecture asynchrone (RabbitMQ) et cache (Redis)

### 6.1 Topologie RabbitMQ

Publication fiable via le **Transactional Outbox Pattern** : l'événement est écrit dans `outbox_events` au sein de la même transaction PostgreSQL que la donnée métier, puis relayé vers RabbitMQ avec *publisher confirms*.

| Exchange (Topic durable) | Files principales (Queues) | Rôle & garantie |
|---|---|---|
| `nexus.attendance` | `q.attendance.normalize`, `q.attendance.daily-calc`, `q.attendance.anomaly` | Normalisation, déduplication et calcul des journées de présence. Idempotence par `event_id`. |
| `nexus.devices` | `q.device.commands`, `q.device.template-sync`, `q.device.health` | Préparation des ordres de sync utilisateurs/révocations/gabarits et surveillance des heartbeats. |
| `nexus.payroll` | `q.payroll.run-calc`, `q.payroll.payslip-pdf`, `q.payroll.declarations` | Calcul parallélisé par tranche d'agents, génération des bulletins PDF et des états DGI/CNSS/INPP/ONEM. |
| `nexus.documents` | `q.documents.badges`, `q.documents.exports`, `q.documents.antivirus` | Génération de planches de badges QR, exports volumineux Excel/PDF et contrôle d'intégrité des fichiers. |
| `nexus.notifications` | `q.notifications.email`, `q.notifications.inapp`, `q.notifications.webhooks` | Envoi découplé des alertes et livraison des webhooks clients avec politique de retry exponentiel. |
| `nexus.dlx` | `q.dlq.*` (une DLQ par domaine) | Isolement, alerte et rejeu contrôlé des messages en échec après N tentatives. |

### 6.2 Usage de Redis

Toutes les clés respectent le préfixe strict `nexus:{env}:t:{tenant_id}:{domaine}:{clé}` :

- **Limitation de débit (*rate limiting*)** : par IP, par utilisateur, par clé API et par terminal biométrique.
- **Sessions & sécurité** : liste de révocation instantanée des JWT (`jti`), compteurs d'échecs de connexion/PIN, défis MFA temporaires.
- **Verrous distribués** : empêcher le lancement simultané de deux calculs ou d'une modification et d'une clôture sur la même période de paie (`lock:payroll:{tenant_id}:{period_id}`).
- **Anti-rebond rapide** : détection sub-milliseconde des doubles passages sur un terminal.
- **Cache applicatif court** : permissions résolues de l'utilisateur, configuration active du tenant, tableau de bord temps réel des présents (invalidation événementielle).

---

## 7. Stockage documentaire compatible S3

- **Convention de clés isolée par tenant** : `tenants/{tenant_id}/{catégorie}/{année}/{uuid_document}` (aucun nom de fichier personnel ou matricule dans le chemin objet S3 pour éviter toute fuite par métadonnées).
- **Sécurité d'accès** : buckets strictement privés (zéro accès public). Téléversement et téléchargement via URLs pré-signées à durée de vie très courte (60 à 300 secondes) émises par `apps/api` après vérification RBAC + tenant + journalisation dans `audit_logs`.
- **Contrôle des fichiers** : validation de la taille, du type MIME réel (*magic bytes*, pas seulement l'extension), calcul et enregistrement de l'empreinte `SHA-256`.
- **Immuabilité paie** : activation recommandée du mode *S3 Object Lock (Compliance/Governance)* en production sur le préfixe des bulletins de paie clôturés et des états déclaratoires officiels.

---

## 8. Flux critiques de bout en bout

### 8.1 Flux d'un pointage biométrique (mode Cloud Push)

```text
Pointeuse (Site Kinshasa) ──[POST HTTPS /iclock/cdata]──► device-gateway
   1. Vérification identité terminal (SN + secret/certificat + état ACTIVE)
   2. Validation structurelle via connecteur ZKTeco isolé
   3. Calcul idempotency_key = SHA256(tenant_id + device_id + raw_uid + timestamp + emp_pin)
   4. INSERT idempotent dans attendance_raw_events + outbox_events (transaction ACID)
   5. Réponse HTTP 200 "OK" immédiate au terminal (< 80 ms)
          │
          ▼ (RabbitMQ: nexus.attendance)
       worker (AttendanceEngine)
   6. Résolution agent, vérification contrat actif & site
   7. Filtrage anti-rebond (événement brut conservé avec statut DUPLICATE_IGNORED)
   8. Appariement shift (fuseau Africa/Kinshasa), calcul retard / pause / dépassement
   9. Mise à jour attendance_daily_summaries + détection anomalie éventuelle
  10. Invalidation cache Redis dashboard site + notification manager si alerte
```

### 8.2 Flux d'un cycle de paie RDC

```text
Gestionnaire Paie ──► Validation clôture des temps (GTA) ──► Création PayrollRun (DRAFT)
   1. Acquisition verrou Redis sur la période
   2. Capture figée (snapshot) du PayrollRuleSet actif + taux de change BCC + effectif INPP
   3. Publication job RabbitMQ -> worker découpe par lots d'agents
   4. Pour chaque agent : PayrollEngine calcule brut, exonérations plafonnées, CNSS,
      assiette IPR, IPR (barème + charges famille + plafond 30% + minimum), IERE si expatrié,
      INPP, ONEM, retenues prêts/avances (contrôle quotité saisissable), net CDF/USD
      + enregistre calculation_trace JSON complet
   5. Génération rapport d'anomalies et d'écarts vs M-1 (statut CALCULATED)
   6. Contrôle RH (REVIEWED) ──► Approbation DAF/DG distinct (APPROVED — SoD)
   7. Clôture irréversible (LOCKED) + signature SHA-256 du livre de paie
   8. Génération asynchrone bulletins PDF -> S3 + publication ESS + états DGI/CNSS/INPP/ONEM + SYSCOHADA
```

---

## 9. Stratégie de déploiement Cloud et compatibilité Arena

### 9.1 Compatibilité avec l'environnement Sandbox Arena (`INFRA_PROFILE=sandbox`)

L'audit initial a montré que le sandbox Arena dispose de Node.js 22, 2 vCPU, 3,8 GiB de RAM et d'un accès npm complet, mais ne contient ni Docker, ni PostgreSQL natif, ni Redis, ni RabbitMQ, ni MinIO. Pour permettre le développement, les tests automatisés et la prévisualisation live interactive sans trahir l'architecture cible :

| Port d'infrastructure | Adaptateur Production & Docker (`production` / `docker`) | Adaptateur Sandbox & Tests rapides (`sandbox`) |
|---|---|---|
| `DatabasePort` | PostgreSQL 16/17 via `pg` + RLS complet | `@electric-sql/pglite` (vrai moteur PostgreSQL compilé en WASM, même SQL et mêmes migrations) |
| `CacheLockPort` | Redis 7 via `ioredis` | Adaptateur mémoire à TTL et verrous mutex (marqué `SANDBOX_ONLY`) |
| `MessageBusPort` | RabbitMQ via `amqplib` + DLQ | Bus asynchrone local respectant la même enveloppe, idempotence, retries et DLQ (marqué `SANDBOX_ONLY`) |
| `ObjectStoragePort` | AWS S3 / Cloudflare R2 / MinIO via `@aws-sdk/client-s3` | Stockage local isolé par tenant avec URLs signées HMAC (marqué `SANDBOX_ONLY`) |

En prévisualisation Arena, les serveurs écoutent sur `0.0.0.0` et le frontend Next.js proxifie `/api/*` vers le backend NestJS par URL relative (aucun appel `localhost` côté navigateur). Le démarrage en production (`NODE_ENV=production` et `INFRA_PROFILE=production`) **refusera catégoriquement** tout adaptateur `sandbox`.

### 9.2 Topologie Cloud de production retenue et options d'évolution

Conformément à la décision du propriétaire (validation Mission 0), **l'Option A (Cloud managé évolutif)** est retenue comme cible principale, sans aucun abonnement ni engagement financier sans autorisation préalable explicite :

1. **Option A — Cloud managé évolutif *(CIBLE VALIDÉE)*** :
   - Conteneurs Docker (`web`, `kiosk`, `api`, `device-gateway`, `worker`) sur plateforme managée (AWS ECS Fargate, Scaleway Containers, Render, Railway ou Fly.io selon la région retenue).
   - PostgreSQL 16 managé avec sauvegardes chiffrées automatiques, restauration à la seconde (PITR) et réplica de lecture optionnel.
   - Redis 7 managé (TLS et authentification ACL obligatoires) + RabbitMQ managé (CloudAMQP ou Amazon MQ, TLS AMQPS).
   - Stockage objet compatible S3 (AWS S3, Cloudflare R2 ou Scaleway S3) avec chiffrement serveur (SSE) et verrouillage d'immuabilité (*Object Lock*) sur les bulletins clôturés.
   - Réseau Edge Cloudflare (WAF, anti-DDoS, TLS 1.3, points de présence africains).
2. **Option B — Serveurs dédiés / VPS durcis *(alternative de maîtrise budgétaire)*** :
   - Cluster Docker / k3s sur serveurs Linux durcis, PostgreSQL + `pgBackRest` chiffré vers S3 externe, Redis, RabbitMQ, MinIO/S3, reverse proxy TLS + WAF.
3. **Option C — Déploiement souverain en RDC *(option réglementaire / grands comptes)*** :
   - Déploiement intégral des mêmes conteneurs Docker + MinIO S3 dans un datacenter situé en RDC (ex. Kinshasa ou Lubumbashi) pour les clients soumis à une obligation stricte de résidence nationale des données (secteur public, institutions financières soumises aux instructions de la BCC, marchés souverains).

### 9.3 Comparatif des régions Cloud : Afrique du Sud vs Europe de l'Ouest (droit congolais & technique)

Au regard de l'**Ordonnance-Loi n° 23/010 du 13 mars 2023 portant Code du Numérique en RDC** (Livre III — protection des données à caractère personnel), tout hébergement situé hors du territoire national de la RDC constitue un **stockage / transfert international de données personnelles**. Un tel transfert n'est licite que si l'État de destination assure un **niveau de protection suffisant/équivalent** de la vie privée et des libertés fondamentales, complété par les formalités requises auprès de l'**Autorité de Protection des Données (APD)** (ou de l'autorité compétente du Ministère du Numérique), l'information/consentement des personnes concernées et des garanties contractuelles (DPA) et techniques (chiffrement).

| Critère d'analyse | Région Afrique du Sud *(Le Cap `af-south-1` / Johannesburg)* | Région Europe de l'Ouest *(Francfort `eu-central-1` / Paris `eu-west-3`)* |
|---|---|---|
| **Cadre légal de protection des données** | **POPIA** (*Protection of Personal Information Act*, Loi n° 4 de 2013, pleinement applicable) — loi moderne protégeant les données personnelles et les données biométriques (*special personal information*, sect. 26), encadrant aussi les transferts ultérieurs (sect. 72). | **RGPD** (*Règlement UE 2016/679*) + lois nationales (BDSG Allemagne / Loi Informatique et Libertés France) — référence mondiale la plus stricte, dont s'inspire directement le Livre III du Code du Numérique congolais ; biométrie classée art. 9. |
| **Autorité de contrôle indépendante** | *Information Regulator (South Africa)* — autorité active, jurisprudence encore plus récente que celle de l'UE. | **BfDI / autorités allemandes** ou **CNIL (France)** — maturité institutionnelle élevée, contrôles stricts des hébergeurs et sous-traitants. |
| **Recevabilité juridique depuis la RDC (OL 23/010)** | **Élevée**, avec l'avantage politique et économique de l'appartenance commune à la **SADC** et au continent africain (cohérence avec la Convention de Malabo de l'UA). Reste juridiquement un pays tiers hors RDC nécessitant les formalités APD et un DPA strict. | **Très élevée** sur le critère d'équivalence/adéquation substantielle : le RGPD offre les garanties juridiques, contractuelles (CCT/SCC) et de certification (ISO 27701, EU Cloud CoC) les plus aisément démontrables devant l'APD, les ONG internationales et les auditeurs de banques/multinationales. Reste également un transfert hors RDC soumis aux formalités APD. |
| **Accès gouvernemental extraterritorial** | Droit sud-africain (RICA) ; si hyperscaler américain (AWS/Azure), attention au *US CLOUD Act* → atténué par chiffrement d'enveloppe et gestion stricte des clés. | Protection forte du RGPD (art. 48) ; possibilité de choisir soit un hyperscaler certifié UE, soit un **fournisseur européen non soumis au US CLOUD Act** (ex. Scaleway Paris, OVHcloud) pour une souveraineté juridique renforcée. |
| **Impact de la décision n° 6 (biométrie locale par défaut)** | Les gabarits biométriques restant **par défaut uniquement dans les terminaux en RDC** (`DEVICE_ONLY`), aucun gabarit biométrique ne franchit la frontière en fonctionnement standard, réduisant fortement la sensibilité réglementaire. | Même bénéfice majeur : en mode par défaut `DEVICE_ONLY`, seuls les horodatages de pointage et données RH/paie chiffrées transitent vers l'UE, sans transfert de gabarits biométriques. |
| **Latence réseau estimée depuis la RDC** | **Excellente** : ~35–65 ms depuis Lubumbashi/Kolwezi (liaisons fibres SADC sud) ; ~55–90 ms depuis Kinshasa/Matadi (câbles sous-marins WACS, Equiano, 2Africa). | **Bonne et tout à fait fluide pour un SaaS RH/Paie** : ~95–135 ms depuis Kinshasa (câbles sous-marins directs vers l'Europe) ; ~130–175 ms depuis Lubumbashi/Goma. Atténuée par CDN Cloudflare et architecture asynchrone/offline. |
| **Disponibilité de la pile managée (Option A)** | Disponible sur **AWS `af-south-1`** (ECS, RDS PostgreSQL, ElastiCache Redis, Amazon MQ/CloudAMQP, S3) et **Azure `southafricanorth`**, mais **absente** chez la plupart des PaaS simples et économiques (Scaleway, Render, Railway). | **Maximale (100 %)** : choix complet entre AWS, Scaleway, Google Cloud, Azure, Render, Railway, Fly.io, CloudAMQP, Cloudflare R2 — facilitant un démarrage progressif sans surdimensionnement. |
| **Coût mensuel d'infrastructure (à capacité égale)** | Généralement **+15 % à +35 % plus élevé** qu'en Europe de l'Ouest (tarifs unitaires compute, RDS et bande passante sortante plus chers en `af-south-1`). | **Référence la plus compétitive** : coûts maîtrisés au lancement, paliers d'entrée plus bas pour le Staging et les premiers clients PME. |
| **Résilience énergétique et multi-AZ** | Datacenters Tier III/IV multi-AZ (AWS Le Cap dispose de 3 zones de disponibilité autonomes en énergie malgré les contraintes historiques du réseau sud-africain). | Datacenters Tier III+/IV multi-AZ très denses, interconnexions redondantes et options de sauvegarde inter-régions UE simples. |

#### Recommandation d'architecture d'hébergement (soumise à décision ultérieure avant déploiement)

1. **Pour le lancement (Staging + Production V1)** : privilégier **l'Europe de l'Ouest (Paris `eu-west-3` — ex. Scaleway/AWS — ou Francfort `eu-central-1`)** couplée à un réseau Edge/CDN ayant des points de présence en Afrique, pour trois raisons concrètes : (a) alignement juridique maximal RGPD / Code du Numérique RDC + possibilité d'hébergeur non soumis au *CLOUD Act*, (b) disponibilité immédiate et économique de toute la pile managée PostgreSQL + Redis + RabbitMQ + S3, et (c) latence largement inférieure aux seuils de confort d'une application RH/Paie et d'un protocole Push biométrique asynchrone.
2. **Pour l'expansion grands comptes (notamment ceinture minière Haut-Katanga / Lualaba ou clients SADC)** : conserver la capacité de déployer une cellule régionale dédiée sur **AWS Afrique du Sud (`af-south-1` Le Cap)** si la latence < 60 ms ou la préférence régionale SADC est exigée au contrat.
3. **Mesures obligatoires quelle que soit la région retenue** : maintien du mode biométrique `DEVICE_ONLY` par défaut, chiffrement TLS 1.3 + AES-256-GCM par tenant, contrat de sous-traitance (DPA) mentionnant explicitement le pays d'hébergement, conformité aux formalités de transfert international de l'OL n° 23/010 auprès de l'APD, et réversibilité totale vers un hébergement local en RDC (Option C).

### 9.4 Pipeline CI/CD (GitHub Actions)

1. **À chaque Pull Request** : vérification formatage/lint, `tsc --noEmit` strict, audit de sécurité des dépendances, détection de secrets, contrôle d'absence de taux codés en dur, tests unitaires (moteur de paie, moteur GTA, connecteurs), tests d'intégration PostgreSQL + isolation RLS multi-tenant, tests E2E critiques (avec services conteneurisés PostgreSQL, Redis, RabbitMQ et MinIO dans GitHub Actions).
2. **Environnement Staging** : déploiement automatique après validation sur branche d'intégration, utilisé notamment pour les tests de connexion HTTPS avec de vraies pointeuses de laboratoire.
3. **Environnement Production** : déploiement manuel approuvé par le propriétaire, migrations SQL vérifiées (rétrocompatibles *expand/contract*), sauvegarde préalable automatique et tests de fumée (*smoke tests*) post-déploiement.
