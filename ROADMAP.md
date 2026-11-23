# FEUILLE DE ROUTE (ROADMAP) — NEXUS RH

## 1. Principes de pilotage du développement

Le développement de **NEXUS RH** est découpé en **11 missions séquencées (Mission 0 à Mission 10)** selon une approche incrémentale orientée produit commercialisable :

1. **Chaque mission livre un incrément complet, fonctionnel, testé et démontrable** (base de données + backend + frontend + sécurité + tests + documentation).
2. **Validation par jalons (Gates)** : aucune mission critique ne démarre et aucune mise en production / fusion de branche n'a lieu sans l'approbation du propriétaire du projet.
3. **Séparation stricte entre logiciel et matériel** : l'absence temporaire d'une pointeuse physique ne bloque jamais l'avancement du socle RH, de la PWA Kiosque (QR Code + PIN), de la GTA ni de la paie complète RDC ; en revanche, aucun connecteur fabricant ne passe au statut `LAB_VALIDATED` ou `PRODUCTION_CERTIFIED` tant qu'il n'a pas passé les 12 tests sur matériel réel.
4. **Zéro dette de sécurité ou de précision** : le multi-tenant RLS, le journal d'audit, le chiffrement et le paramétrage intégral de la paie sont construits **dès le premier jour**, et non ajoutés après coup.

---

## 2. Vue synthétique des missions

```text
M0  Audit & Fondations Documentaires ─────────────────────────────► [JALON ACTUEL]
 │
 ▼
M1  Socle Monorepo, Infra, Multi-Tenancy RLS, Auth/MFA, RBAC & Audit
 │
 ▼
M2  Entreprises, Multi-Sites (WAT/CAT), Agents, Contrats, Matricules, Badges QR & S3
 │
 ▼
M3  Horaires, Shifts, Jours Fériés RDC, Congés, Absences & Moteur GTA
 │
 ▼
M4  PWA Kiosque Tablette/Mobile (QR + PIN Offline) + Framework Biométrique & Simulateur
 │                                                    │
 ▼                                                    ▼ (en parallèle dès réception matériel)
M6  Moteur de Paie RDC 100 % Paramétrable            M5  Device Gateway + Connecteur ZKTeco
    (Devises, CNSS, INPP, ONEM, IPR, IERE, Prêts)        + Nexus Edge Agent + Homologation Labo
 │                                                    │
 ▼                                                    │
M7  Bulletins PDF, Déclarations DGI/CNSS/INPP/ONEM,  │
    SYSCOHADA, Virements, Décompte Final & ESS ◄──────┘
 │
 ▼
M8  Rapports & BI RH/Paie, Abonnements SaaS, Notifications, API Externe & Webhooks
 │
 ▼
M9  Extension Biométrique Multi-Marques (Vague 2 Hikvision → Vague 3 Anviz → Vague 4 Suprema)
 │
 ▼
M10 Durcissement Sécurité, Conformité APD, Déploiement Cloud, Pilote Client & Lancement V1
```

> *Note d'ordonnancement : les Missions M5 (ZKTeco réel) et M6 (Paie RDC) peuvent être permutées selon la date de disponibilité de la première pointeuse physique de test.*

---

## 3. Plan détaillé mission par mission

### Mission 0 — Audit et Préparation Documentaire *(Mission actuelle)*
- **Objectifs** : inspecter le dépôt et l'environnement, concevoir l'architecture cible, rédiger les 10 documents fondateurs, identifier les risques, prérequis matériels et décisions propriétaires.
- **Livrables** : `README.md`, `VISION.md`, `CAHIER_DES_CHARGES.md`, `ARCHITECTURE_TECHNIQUE.md`, `DATABASE_SCHEMA.md`, `SECURITY_POLICY.md`, `BIOMETRIC_INTEGRATION_PLAN.md`, `PAYROLL_RULES_RDC.md`, `ROADMAP.md`, `TEST_STRATEGY.md` + rapport complet d'audit.
- **Code modifié** : aucun.
- **Critère de sortie (Gate 0)** : approbation explicite des documents et des décisions structurantes par le propriétaire du projet.

---

### Mission 1 — Socle Technique, Sécurité Multi-Tenant, RBAC et Audit
- **Objectifs** : poser des fondations industrielles irréprochables pour l'ensemble du produit.
- **Livrables** :
  - Initialisation du monorepo (`pnpm` + `Turborepo`, TypeScript strict, ESLint, Prettier, Vitest, GitHub Actions CI).
  - Configuration `infra/docker/docker-compose.yml` (PostgreSQL 16, Redis 7, RabbitMQ avec management, MinIO S3) + adaptateurs Ports & Adapters pour l'exécution et la prévisualisation live dans le sandbox Arena.
  - Schéma initial Drizzle + migrations + mécanisme PostgreSQL **Row-Level Security (`FORCE RLS`)** + intercepteur de contexte tenant.
  - Authentification complète (Argon2id, JWT courte durée + Refresh Token rotatif HttpOnly, MFA TOTP, verrouillage anti-force brute).
  - Système RBAC + périmètre par établissement + règles de séparation des tâches (SoD).
  - Module `crypto-audit` (chiffrement d'enveloppe AES-256-GCM + journal d'audit append-only chaîné SHA-256).
  - Shell applicatif Next.js (`apps/web`) avec système de design professionnel, navigation multi-tenant, console Super-Admin (création/gestion d'entreprises) et gestion des utilisateurs/rôles/audit.
- **Critères d'acceptation** : suite de tests automatisés prouvant l'étanchéité totale entre deux tenants A et B ; vérification cryptographique de la chaîne d'audit ; prévisualisation fonctionnelle.

---

### Mission 2 — Organisation Multi-Sites, Agents, Contrats, Matricules, Badges QR et Documents S3
- **Objectifs** : livrer le cœur SIRH (administration du personnel) complet et prêt à l'emploi.
- **Livrables** :
  - Gestion complète de l'entreprise (RCCM, Id. Nat., NIF, CNSS, INPP, ONEM, logo) et de ses établissements multi-provinces avec fuseaux `Africa/Kinshasa` et `Africa/Lubumbashi`, géolocalisation, départements, postes, catégories professionnelles RDC et centres de coûts.
  - Dossiers agents complets (nom, post-nom, prénom, état civil, statut national/expatrié, personnes à charge avec justificatifs, coordonnées bancaires/Mobile Money chiffrées).
  - Générateur atomique de matricules paramétrables.
  - Générateur automatique de badges professionnels PDF (CR80) avec QR Code signé révocable + gestion du code PIN personnel haché Argon2id.
  - Gestion des contrats (CDI, CDD avec alertes d'échéance/renouvellement, journalier avec alerte de seuil légal, stage, consultant), avenants, mutations inter-sites et fins de contrat.
  - Coffre-fort documentaire compatible S3 (upload/download par URLs pré-signées, contrôle MIME/SHA-256, alertes d'expiration) + import Excel/CSV contrôlé des agents.
  - Module de gestion du **consentement biométrique RDC** (formulaire signé obligatoire, statut, révocation et journal de purge).
- **Critères d'acceptation** : cycle complet de vie d'un agent testé de l'embauche à la mutation inter-fuseaux et à la révocation de badge ; zéro collision de matricule sous 100 créations concurrentes.

---

### Mission 3 — Horaires, Vacations (Shifts), Jours Fériés, Congés et Moteur GTA
- **Objectifs** : structurer les règles de temps de travail, d'absences et de congés avant d'y brancher les terminaux et la paie.
- **Livrables** :
  - Bibliothèque `packages/attendance-engine` pure et couverte par tests unitaires exhaustifs.
  - Gestion des horaires fixes, flexibles, vacations de nuit franchissant minuit et cycles rotatifs (2×8, 3×8, rotations minières, gardes hospitalières) + affectation individuelle ou par équipe.
  - Calendrier paramétrable des jours fériés RDC (nationaux et par site).
  - Calcul quotidien des présences, retards (franchises/paliers), départs anticipés, heures de nuit, heures supplémentaires ventilées par tranche (avec workflow d'approbation managériale) et absences à qualifier.
  - Workflow de régularisation manuelle motivée avec approbation N+1 et distinction visuelle permanente.
  - Module complet de congés et permissions (paramétrage des types, acquisition mensuelle automatique, majoration d'ancienneté, soldes, demandes, justificatifs, approbation multi-niveaux).
  - Écran de clôture mensuelle des temps (pré-paie) par établissement.
- **Critères d'acceptation** : exactitude prouvée sur shifts de jour, shifts de nuit, jours fériés, passage Kinshasa/Lubumbashi et calcul des soldes de congés.

---

### Mission 4 — PWA Kiosque Tablette/Mobile (QR + PIN Offline) et Socle Biométrique
- **Objectifs** : rendre le pointage terrain immédiatement opérationnel sur tablette/smartphone (sans dépendre d'un achat matériel propriétaire) et préparer l'infrastructure multi-marques.
- **Livrables** :
  - Application PWA `apps/kiosk` installable (manifeste, Service Worker, mode hors ligne complet avec IndexedDB chiffré AES-GCM, enrôlement sécurisé par site, scan caméra QR statique & dynamique TOTP, clavier PIN, anti-rebond, détection de dérive d'horloge, géorepérage optionnel, synchronisation automatique résiliente).
  - Service `apps/device-gateway` et files RabbitMQ (`nexus.attendance`, `nexus.devices`, DLQ) + Outbox transactionnel.
  - Package `packages/biometric-connectors` : interface `IBiometricConnector`, registre de maturité, vérification de compatibilité des gabarits, chiffrement AES-256-GCM des gabarits et purge automatique au retrait du consentement.
  - Console d'administration du parc (kiosques, terminaux, heartbeats, files de commandes, badges de maturité explicites).
  - Simulateur de protocole strictement isolé (`SIMULATED`, `is_simulated = true`) pour tester les flux de charge et de panne sans jamais polluer les données réelles.
- **Critères d'acceptation** : pointage QR et PIN fonctionnel en mode hors ligne complet puis synchronisation exacte sans doublon ; preuve automatisée qu'un pointage `is_simulated = true` est rejeté par la clôture de paie réelle.

---

### Mission 5 — Connecteur ZKTeco, Nexus Edge Agent et Homologation Matérielle Vague 1
- **Objectifs** : livrer et certifier la première intégration de pointeuse biométrique physique (empreinte + reconnaissance faciale + PIN).
- **Livrables** :
  - Connecteur **ZKTeco ADMS / ICLOCK Push** (ingestion temps réel/différé, heartbeats, file de commandes : sync agents, PIN, gabarits compatibles, suppression immédiate, sync horaire).
  - Application `apps/edge-agent` + connecteur **ZKTeco LAN (TCP 4370)** avec tampon local chiffré hors ligne et remontée HTTPS/mTLS vers `device-gateway`.
  - Import de secours audité de fichiers journaux USB ZKTeco (`USB_IMPORT`).
  - Statut initial `PROTOCOL_IMPLEMENTED`, puis exécution du protocole d'homologation en 12 points sur vraie pointeuse ZKTeco (dès mise à disposition du banc d'essai) pour passer à `LAB_VALIDATED` puis `PRODUCTION_CERTIFIED` avec procès-verbal officiel.
- **Dépendance externe** : disponibilité du banc d'essai ZKTeco et d'un endpoint Staging HTTPS pour le passage au-delà de `PROTOCOL_IMPLEMENTED`.

---

### Mission 6 — Moteur de Paie RDC 100 % Paramétrable
- **Objectifs** : livrer le moteur de calcul salarial complet, exact, bi-devise et intégralement piloté par règles versionnées.
- **Livrables** :
  - Bibliothèque `packages/payroll-engine` (10 étapes en `decimal.js`, zéro taux en dur, `CalculationTrace` intégral).
  - Interfaces d'administration versionnées : jeux de règles (`PayrollRuleSet`), devises et taux de change BCC/paie, grille SMIG, rubriques et formules DSL sécurisées, plafonds d'exonération (logement, transport par zone/mode, allocations familiales), cotisations (CNSS par branche, INPP par effectif, ONEM, conventionnelles), barèmes IPR (progressif, réductions charges de famille, plafond, minimum, occasionnels, fin de carrière), régimes IERE expatriés, règles d'heures sup. et quotité saisissable.
  - Gestion des éléments récurrents et variables du mois, acomptes de quinzaine, avances, prêts échelonnés et saisies-arrêts.
  - Intégration automatique des variables de temps clôturées (Mission 3).
  - Exécution asynchrone (RabbitMQ + verrou Redis) des simulations et cycles de paie, tableau de contrôle des écarts M/M-1, workflow Maker-Checker (Calcul → Revue RH → Approbation DAF/DG → Clôture immuable `LOCKED`), rappels rétroactifs et assistant de **décompte final**.
- **Critères d'acceptation** : 100 % de concordance au centime/franc près avec un cahier de cas de test validé par un praticien/comptable paie RDC ; test CI vérifiant l'absence totale de constantes fiscales/sociales codées en dur.

---

### Mission 7 — Bulletins PDF, États Déclaratoires, SYSCOHADA, Virements et Portail Agent (ESS)
- **Objectifs** : industrialiser tous les documents légaux post-paie et ouvrir l'autonomie encadrée aux agents.
- **Livrables** :
  - Génération unitaire et en masse des bulletins de paie PDF conformes RDC (bi-devise, trace présence, soldes congés, hash SHA-256 de vérification) archivés sur S3.
  - Livre de paie, bordereaux nominatifs et récapitulatifs **DGI (IPR, IERE)**, **CNSS**, **INPP** et **ONEM** (PDF, Excel, CSV paramétrable).
  - Générateur d'ordres de virement bancaire (CDF/USD), listes Mobile Money, états d'émargement caisse et journal comptable **SYSCOHADA révisé** (avec ventilation analytique site/projet).
  - Portail Self-Service Agent (ESS — Web & PWA smartphone) : badge QR (statique/dynamique), planning, historique de pointages, demandes de congés et d'acomptes, téléchargement sécurisé des bulletins et attestations RH.
- **Critères d'acceptation** : génération fluide d'un lot de 1 000 bulletins PDF en test de performance ; équilibre débit = crédit strict à 100 % sur tous les exports SYSCOHADA.

---

### Mission 8 — Tableaux de Bord, Commercialisation SaaS, Notifications et API Externe
- **Objectifs** : transformer l'application en produit SaaS pleinement exploitable et commercialisable à grande échelle.
- **Livrables** :
  - Tableaux de bord exécutifs et analytiques (présences temps réel multi-sites, absentéisme, ponctualité, effectifs, turnover, masse salariale, charges, heures sup., projections) et exports personnalisables.
  - Gestion commerciale SaaS : plans, quotas, périodes d'essai, facturation d'abonnement, onboarding guidé d'une nouvelle entreprise, mode Cabinet/Groupe et export de réversibilité.
  - Centre de notifications (in-app, courriel) et alertes proactives (fins de CDD/essai/permis de travail, échéance déclarative du 15, terminaux hors ligne).
  - API externe `/api/v1` documentée OpenAPI 3.1 (clés API à scopes, rate limiting) et webhooks signés HMAC-SHA256.
- **Critères d'acceptation** : parcours complet d'inscription/provisionnement d'une nouvelle entreprise cliente jusqu'à sa première paie clôturée sans intervention technique en base.

---

### Mission 9 — Extension Biométrique Multi-Marques (Hikvision, Anviz, Suprema et autres)
- **Objectifs** : élargir progressivement le catalogue de pointeuses supportées et certifiées.
- **Sous-phases indépendantes** :
  - **M9.1 — Connecteur Hikvision** (ISAPI HTTPS + HTTP Listening / ISUP 5.0 — terminaux faciaux et empreintes *MinMoe*) + homologation matérielle.
  - **M9.2 — Connecteur Anviz** (Cloud Push / WebSocket + TCP 5010 via Edge Agent) + homologation matérielle.
  - **M9.3 — Connecteur Suprema** (G-SDK gRPC/TLS & BioStar 2 API) + homologation matérielle.
  - **M9.4 — Kit d'extension tiers** (documentation et gabarit de connecteur pour Dahua, IDEMIA/Morpho, FingerTec).
- **Critères d'acceptation** : fonctionnement simultané, au sein d'un même tenant multi-sites, de terminaux de marques différentes + PWA Kiosque alimentant sans friction un même cycle de paie.

---

### Mission 10 — Durcissement, Déploiement Cloud Production, Pilote Réel et Lancement
- **Objectifs** : valider la robustesse opérationnelle, juridique et sécurité avant commercialisation générale.
- **Livrables** :
  - Audit de sécurité approfondi (tests d'intrusion OWASP, revue RLS, revue cryptographique, tests de charge k6, test réel de restauration de sauvegarde PRA/PITR).
  - Dossier de conformité juridique RDC (modèle de formulaire de consentement biométrique bilingue/français, modèle de DPA sous-traitant, modèle d'AIPD et registre APD, CGU/CGV SaaS — à faire relire par un conseil juridique RDC).
  - Mise en production cloud sur l'infrastructure approuvée, monitoring 24/7, alertes et manuels d'exploitation (*runbooks*).
  - **Pilote en double commande** (1 à 2 mois sur une entreprise pilote réelle : comparaison parallèle NEXUS RH vs paie existante jusqu'à 0 écart constaté).
- **Critère de sortie (Go-Live commercial)** : validation formelle du propriétaire du projet après succès complet du pilote.
