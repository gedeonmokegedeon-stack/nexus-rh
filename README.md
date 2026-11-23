# NEXUS RH

> **Plateforme SaaS multi-entreprises et multi-sites de gestion des ressources humaines, des présences biométriques multi-marques et de la paie complète — conçue pour la République Démocratique du Congo et extensible à l'espace OHADA.**

---

## Statut du projet

| Élément | État actuel |
|---|---|
| **Mission 0 (Audit & Documentation)** | **VALIDÉE** (17 novembre 2026 — 10 documents de référence sauvegardés) |
| **Phase active** | **Mission 1 — Socle technique, sécurité multi-tenant, RBAC et audit** |
| **Intégrations biométriques** | Spécifiées uniquement (`SPECIFIED`) — stockage local sur terminal (`DEVICE_ONLY`) par défaut |
| **Moteur de paie RDC** | Spécifié (`CDF`/`USD`, IPR, IERE, CNSS, INPP, ONEM, SYSCOHADA) — 100 % paramétrable et versionné |
| **Hébergement cible** | Option A — Cloud managé évolutif (comparatif Afrique du Sud vs Europe dans `ARCHITECTURE_TECHNIQUE.md`) |
| **Licence** | **Propriétaire commerciale — Tous droits réservés** |
| **Dernière mise à jour** | 17 novembre 2026 |

---

## Présentation générale

**NEXUS RH** est une solution logicielle SaaS professionnelle destinée aux entreprises, institutions, industries, banques, structures hospitalières, établissements d'enseignement, sociétés minières, entreprises de BTP, sociétés de gardiennage et ONG opérant en République Démocratique du Congo (RDC).

La plateforme unifie dans un environnement sécurisé et multi-sites :

1. **Administration RH multi-entreprises et multi-établissements** : gestion des sociétés (tenants), succursales/sites multi-provinces (fuseaux `Africa/Kinshasa` UTC+1 et `Africa/Lubumbashi` UTC+2), départements, postes, catégories professionnelles, dossiers agents, contrats, matricules et badges QR Codes automatiques, archivage documentaire chiffré.
2. **Gestion des présences multi-modale et multi-marques** : pointage par empreinte digitale, reconnaissance faciale (sur terminaux compatibles), QR Code et code PIN sur tablette/smartphone (PWA fonctionnant hors ligne), avec connecteurs indépendants et évolutifs pour **ZKTeco, Hikvision, Anviz, Suprema** et autres fabricants.
3. **Gestion des temps et des activités (GTA)** : horaires fixes, variables et par roulement (shifts jour/nuit/24h), calcul automatique des retards, heures supplémentaires, jours fériés, absences, permissions et congés avec circuits d'approbation.
4. **Paie complète et paramétrable RDC** : calcul multi-devises (CDF, USD, EUR) avec historisation des taux de change, cotisations sociales (CNSS, INPP, ONEM) et fiscalité (IPR, IERE, régimes spécifiques) intégralement paramétrables et versionnées par date d'effet, gestion des acomptes/avances/prêts/saisies, décompte final, bulletins de paie PDF vérifiables, états déclaratoires et écritures comptables SYSCOHADA.
5. **Pilotage, conformité et sécurité** : tableaux de bord décisionnels, exports analytiques, portail self-service agent (ESS), contrôle d'accès granulaire (RBAC/ABAC), journal d'audit immuable et conformité au Code du Travail et au Code du Numérique de la RDC.

---

## Pile technologique cible

| Couche | Technologie cible | Rôle principal |
|---|---|---|
| **Frontend Web & Portail RH/ESS** | Next.js 16 (App Router), React 19, TypeScript | Application SaaS multi-tenant, tableaux de bord, administration RH et paie |
| **Application Terrain & Kiosque** | PWA (Next.js / Service Worker / IndexedDB chiffré) | Pointage tablette QR Code + PIN hors ligne, portail mobile agent/manager |
| **Backend API & Services** | NestJS 12, Node.js 22 LTS, TypeScript 6 | API Core REST, Device Gateway biométrique, Workers asynchrones |
| **Agent local optionnel** | Nexus Edge Agent (Node.js / TypeScript) | Passerelle LAN sécurisée pour pointeuses sans mode Cloud Push et sites à connectivité instable |
| **Base de données** | PostgreSQL 16/17 + Row-Level Security (RLS) + Drizzle ORM | Persistance relationnelle ACID, isolation stricte inter-entreprises, partitionnement |
| **Cache & coordination** | Redis 7 | Sessions, révocation de jetons, limitation de débit (rate limiting), verrous distribués, cache |
| **Messagerie asynchrone** | RabbitMQ 3/4 (AMQP + Dead-Letter Queues) | Ingestion découplée des pointages, commandes terminaux, calculs de paie, génération PDF, notifications |
| **Stockage documentaire** | Compatible S3 (AWS S3 / Cloudflare R2 / MinIO) | Contrats, pièces RH, bulletins PDF signés, exports déclaratoires, sauvegardes chiffrées |
| **Monorepo & Qualité** | pnpm Workspaces, Turborepo, Vitest, Playwright, GitHub Actions | Industrialisation, partage de types stricts, tests automatisés et CI/CD |

---

## Documentation de référence du projet

L'ensemble des fondations produit, fonctionnelles, techniques, réglementaires et qualité est regroupé dans les dix documents officiels à la racine du dépôt :

| Document | Contenu et finalité |
|---|---|
| [`README.md`](./README.md) | Point d'entrée général du projet, statut courant, pile technique et gouvernance |
| [`VISION.md`](./VISION.md) | Vision produit, étude des besoins terrain RDC, positionnement commercial SaaS, personas et modèle d'affaires |
| [`CAHIER_DES_CHARGES.md`](./CAHIER_DES_CHARGES.md) | Spécifications fonctionnelles (`RF`) et non fonctionnelles (`RNF`) exhaustives de tous les modules |
| [`ARCHITECTURE_TECHNIQUE.md`](./ARCHITECTURE_TECHNIQUE.md) | Architecture monorepo, microservices modulaires, multi-tenancy RLS, Redis, RabbitMQ, S3, PWA, API et déploiement cloud |
| [`DATABASE_SCHEMA.md`](./DATABASE_SCHEMA.md) | Schéma relationnel PostgreSQL complet, contraintes, index, partitionnement, politiques RLS et audit |
| [`SECURITY_POLICY.md`](./SECURITY_POLICY.md) | Politique de sécurité, modèle de menaces, chiffrement, RBAC/SoD et conformité légale biométrique en RDC |
| [`BIOMETRIC_INTEGRATION_PLAN.md`](./BIOMETRIC_INTEGRATION_PLAN.md) | Architecture des connecteurs par fabricant (ZKTeco, Hikvision, Anviz, Suprema, autres), niveaux de maturité et prérequis matériels |
| [`PAYROLL_RULES_RDC.md`](./PAYROLL_RULES_RDC.md) | Spécification du moteur de paie paramétrable RDC (CNSS, INPP, ONEM, IPR, IERE, multi-devises, décompte final, SYSCOHADA) |
| [`ROADMAP.md`](./ROADMAP.md) | Plan de développement séquencé par missions, livrables, critères d'acceptation, dépendances et jalons de validation |
| [`TEST_STRATEGY.md`](./TEST_STRATEGY.md) | Stratégie de tests unitaires, d'intégration, d'isolation multi-tenant, de certification paie et d'homologation sur vraies pointeuses |

---

## Engagements d'ingénierie non négociables

1. **Isolation multi-entreprises hermétique** : aucune donnée d'une entreprise cliente ne peut être lue ni altérée par une autre, grâce au double verrou applicatif (guards NestJS) et base de données (PostgreSQL Row-Level Security).
2. **Transparence absolue sur les connecteurs biométriques** : chaque connecteur affiche un statut de maturité explicite (`SPECIFIED`, `SIMULATED`, `PROTOCOL_IMPLEMENTED`, `LAB_VALIDATED`, `PRODUCTION_CERTIFIED`). Un simulateur logiciel est strictement identifié comme `[SIMULATION]` et ne peut jamais être présenté comme une intégration matérielle opérationnelle ni alimenter une paie réelle.
3. **Zéro taux fiscal ou social codé en dur** : tous les taux, barèmes, plafonds, planchers (SMIG), réductions familiales, règles d'heures supplémentaires et taux de change sont stockés en base de données, versionnés par date d'effet et modifiables sans redéploiement de code.
4. **Conformité légale aux données biométriques en RDC** : consentement écrit préalable et révocable, interdiction par défaut du stockage d'images biométriques brutes, chiffrement AES-256-GCM des gabarits, fourniture obligatoire d'une alternative non biométrique (QR Code / PIN), purge à la fin du contrat et alignement sur l'Ordonnance-Loi n° 23/010 du 13 mars 2023 portant Code du Numérique.
5. **Intégrité et traçabilité financière** : calculs monétaires en arithmétique décimale exacte, trace explicative de chaque rubrique de paie, verrouillage immuable des périodes clôturées et journal d'audit chaîné cryptographiquement.
6. **Résilience aux réalités terrain** : prise en charge native des coupures d'électricité et d'Internet (kiosque PWA hors ligne, mémoire tampon des pointeuses, Nexus Edge Agent, ingestion idempotente et déduplication stricte).

---

## Structure cible du dépôt (à partir de la Mission 1)

> *Note : cette arborescence n'est pas encore créée durant la Mission 0. Elle sera initialisée uniquement après approbation explicite de l'architecture par le propriétaire du projet.*

```text
nexus-rh/
├── apps/
│   ├── web/                  # Application SaaS Next.js (RH, Paie, Direction, Admin, ESS)
│   ├── kiosk/                # PWA Tablette/Smartphone (Pointage QR Code & PIN hors ligne)
│   ├── api/                  # Backend principal NestJS (REST API, RBAC, Métier)
│   ├── device-gateway/       # Passerelle d'ingestion biométrique isolée (NestJS)
│   ├── worker/               # Consommateurs asynchrones RabbitMQ (GTA, Paie, PDF, Sync)
│   └── edge-agent/           # Agent local optionnel (synchronisation LAN -> Cloud HTTPS)
├── packages/
│   ├── database/             # Schéma Drizzle, migrations PostgreSQL, politiques RLS
│   ├── payroll-engine/       # Moteur de calcul de paie pur, déterministe et paramétrable
│   ├── attendance-engine/    # Moteur de calcul des temps, shifts, retards et heures sup.
│   ├── biometric-connectors/ # Interface commune + connecteurs isolés par fabricant
│   ├── shared-types/         # Contrats TypeScript, schémas Zod, constantes métier
│   ├── crypto-audit/         # Chiffrement d'enveloppe AES-256-GCM, signature QR, audit SHA-256
│   └── ui/                   # Système de design et composants React partagés
├── infra/
│   ├── docker/               # Docker Compose (PostgreSQL, Redis, RabbitMQ, MinIO) & Dockerfiles
│   └── scripts/              # Scripts de sauvegarde, vérification d'intégrité et déploiement
└── docs/                     # Guides d'exploitation, runbooks et PV d'homologation matérielle
```

---

## Gouvernance du dépôt

- Toute évolution majeure d'architecture, de schéma de paie ou de politique de sécurité fait l'objet d'une validation explicite du propriétaire du projet.
- Aucune donnée personnelle ou biométrique réelle ne doit être commitée dans le dépôt Git.
- Aucun secret (clé API, mot de passe, certificat, clé de chiffrement) ne doit figurer dans le code source.
- Chaque fusion vers la branche principale est conditionnée au passage intégral des contrôles automatisés définis dans [`TEST_STRATEGY.md`](./TEST_STRATEGY.md).
