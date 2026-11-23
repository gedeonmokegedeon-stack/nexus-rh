# STRATÉGIE DE TEST ET D'ASSURANCE QUALITÉ — NEXUS RH

## 1. Objectifs qualité

Dans un logiciel de ressources humaines, de pointage et de paie, une anomalie logicielle a des conséquences humaines, financières et juridiques immédiates : salaire erroné, pénalité fiscale DGI/CNSS, conflit social ou exposition de données sensibles.

La stratégie de test de **NEXUS RH** vise quatre garanties vérifiables automatiquement :

1. **Exactitude mathématique absolue** du moteur des temps (GTA) et du moteur de paie RDC.
2. **Étanchéité totale** entre les entreprises clientes (multi-tenancy) et respect strict des permissions (RBAC/SoD).
3. **Résilience et idempotence** de la collecte des pointages (zéro perte, zéro doublon, zéro confusion entre simulation et matériel réel).
4. **Non-régression continue** à chaque modification de code ou de schéma de base de données.

---

## 2. Règles strictes sur les données de test

1. **Interdiction des fausses données présentées comme réelles** : toute fixture de test automatisé ou jeu de démonstration utilise des noms manifestement fictifs, des entreprises marquées `is_demo_tenant = true` et, pour les émulateurs de terminaux, le drapeau obligatoire `is_simulated = true` accompagné d'un bandeau visuel explicite `[SIMULATION / DÉMO]`.
2. **Interdiction des données réelles en test/CI** : aucun nom réel de salarié client, aucun bulletin réel, aucun numéro de compte réel et **aucun gabarit biométrique réel** ne peuvent être stockés dans le dépôt Git ni utilisés dans les pipelines CI.
3. **Interdiction des données codées en dur en production** : le déploiement d'une instance de production démarre avec une base vierge de tout agent ou pointage fictif.

---

## 3. Pyramide des tests

```text
                    ┌───────────────────────────────┐
                    │ 5. Homologation Physique Labo │  Vraies pointeuses & tablettes (12 tests)
                  ┌─┴───────────────────────────────┴─┐
                  │ 4. E2E, PWA Offline, Sécu & Charge│  Playwright, k6, audits OWASP
               ┌──┴───────────────────────────────────┴──┐
               │ 3. Intégration API, BDD RLS & Messagerie│  NestJS + PostgreSQL/PGlite + RabbitMQ + Redis + S3
            ┌──┴─────────────────────────────────────────┴──┐
            │ 2. Tests de Contrats & Propriétés (Fuzzing)   │  fast-check (paie/arrondis), schémas Zod, trames
         ┌──┴───────────────────────────────────────────────┴──┐
         │ 1. Tests Unitaires Déterministes (Vitest)           │  payroll-engine, attendance-engine, crypto, RBAC
         └─────────────────────────────────────────────────────┘
```

### Objectifs minimaux de couverture

| Périmètre | Seuil minimal exigé |
|---|---|
| `packages/payroll-engine` (calcul de paie RDC) | **≥ 98 % lignes / ≥ 95 % branches** (100 % des formules fiscales et sociales) |
| `packages/attendance-engine` (horaires, shifts, retards, HS, fuseaux) | **≥ 95 % lignes / ≥ 90 % branches** |
| `packages/crypto-audit` (AES-256-GCM, QR signé, Argon2id, chaîne SHA-256) | **≥ 95 % lignes** |
| `packages/biometric-connectors` (parseurs, commandes, compatibilité gabarits) | **≥ 90 % lignes** par connecteur |
| Isolation multi-tenant (RLS + Guards) | **100 % des endpoints protégés** couverts par tests d'accès croisé |
| Contrôle statique anti-taux-en-dur | **100 % bloquant en CI** |

---

## 4. Stratégie de test par domaine critique

### 4.1 Moteur de paie RDC (`packages/payroll-engine`)

1. **Matrice de cas de référence (*Golden Master*)** — validée avec un comptable/fiscaliste RDC :
   - Agent national au SMIG (contrôle plancher, exonérations, impôt minimum IPR).
   - Agent d'exécution en CDF avec 0, 3, 9 et 12 personnes à charge (vérification du plafonnement du nombre de personnes à charge).
   - Agent de maîtrise en USD converti au taux BCC, avec heures supplémentaires sur les 3 tranches (6 premières heures, suivantes, jour férié) et heures de nuit.
   - Cadre supérieur atteignant la tranche marginale haute et déclenchant le **plafonnement global de l'IPR (ex. 30 %)**.
   - Agent avec indemnité de logement dépassant le plafond légal (30 %) et indemnité de transport dépassant le plafond journalier de sa ville → vérification de la réintégration exacte du seul excédent.
   - Agent avec allocations familiales mixtes (part légale exonérée + part extralégale imposable).
   - Agent **expatrié** soumis à l'IERE (régime général et régime sectoriel minier).
   - Entreprises de 25 agents, 120 agents, 450 agents et entreprise publique → vérification du changement automatique de tranche **INPP**.
   - Embauche le 12 du mois et départ le 20 du mois (prorata exact).
   - Congé annuel payé, congé de maternité, absence justifiée, absence injustifiée et mise à pied.
   - Acompte de quinzaine + prêt interne + saisie-arrêt dépassant la quotité saisissable → vérification du plafonnement légal et du report.
   - Paiement mixte (*split* CDF + USD) et vérification de l'équilibre comptable SYSCOHADA (`∑ Débits === ∑ Crédits` au centime près).
   - Décompte final complet (démission, licenciement avec préavis, faute lourde, fin de CDD, retraite).
   - **Test de non-codage en dur** : modification dynamique en base d'un taux CNSS, d'une tranche IPR, du taux ONEM et du taux BCC → vérification que le moteur applique immédiatement les nouvelles valeurs sans toucher au code, tandis qu'une paie déjà `LOCKED` conserve intact son ancien snapshot.
2. **Tests par propriétés (*Property-Based Testing* avec `fast-check`)** :
   - Génération de milliers de combinaisons aléatoires valides de salaires, taux de change et personnes à charge pour vérifier les invariants : absence de `NaN`/`Infinity`, monotonie du barème progressif, respect du plafond effectif IPR, `Net = Brut − Retenues`, déterminisme parfait sur exécutions répétées.

### 4.2 Gestion des temps et multi-fuseaux (`packages/attendance-engine`)

- Shifts standards, shifts de nuit (ex. `22:00 → 06:00` à cheval sur deux dates civiles et sur une fin de mois `30/11 → 01/12`), gardes de 24 h et rotations minières.
- Entreprise ayant simultanément un site en `Africa/Kinshasa` (`UTC+1`) et un site en `Africa/Lubumbashi` (`UTC+2`) : preuve qu'un pointage à `08:00` heure locale sur chaque site (soit `07:00Z` et `06:00Z`) produit 0 minute de retard sur les deux sites.
- Paires incomplètes (entrée sans sortie, sortie sans entrée), doubles pointages en 45 secondes (anti-rebond), pointages arrivant dans le désordre après une coupure réseau de 48 heures (idempotence et recalcul identique quel que soit l'ordre d'arrivée).
- Interactions pointage / jour férié / congé approuvé (cas d'un agent rappelé au travail un jour férié).

### 4.3 Sécurité, isolation multi-tenant et conformité biométrique

1. **Suite automatisée d'intrusion inter-tenant** :
   - Création de `Tenant_A` et `Tenant_B`. Pour chaque route API (`GET`, `POST`, `PATCH`, `DELETE`, export, URL S3), un utilisateur administrateur de `Tenant_A` tente d'accéder ou de modifier une ressource portant un UUID de `Tenant_B` → exigence : rejet systématique (`404`/`403`) et 0 ligne retournée par PostgreSQL RLS.
2. **Tests RBAC et Séparation des Tâches (SoD)** :
   - Un `SITE_MANAGER` du site de Matadi ne peut lire ni les agents de Kinshasa ni aucun salaire.
   - Un `PAYROLL_MANAGER` ne peut pas approuver le `PayrollRun` qu'il a lui-même calculé.
   - Un `BIOMETRIC_ADMIN` ne peut lire aucun contrat ni bulletin.
3. **Tests de conformité biométrique RDC** :
   - Tentative d'insertion d'un gabarit sans consentement `GRANTED` ou sans document signé → rejet.
   - Inspection brute de la colonne `encrypted_template` en base → absence totale du payload en clair ; échec de déchiffrement avec la clé d'un autre tenant ou après altération d'un seul bit (vérification du tag GCM).
   - Retrait du consentement → vérification immédiate : 0 ligne restante dans `biometric_templates`, commandes `DELETE_TEMPLATE` créées en priorité 1 pour tous les terminaux concernés, entrée immuable dans `audit_logs`, pointage QR/PIN de l'agent toujours opérationnel.
4. **Tests d'immuabilité** :
   - Tentative directe d'`UPDATE` ou `DELETE` SQL sur `audit_logs`, `attendance_raw_events` et un `payroll_payslips` verrouillé → rejet par déclencheur PostgreSQL.
   - Tentative d'altération d'une ligne d'audit par un rôle privilégié de test → détection immédiate par le vérificateur de chaîne `SHA-256`.

### 4.4 PWA Kiosque Tablette et mode hors ligne (Playwright)

- Appairage d'une tablette kiosque, téléchargement du cache chiffré, bascule du navigateur en mode `offline`, exécution de 100 pointages (QR valide, QR révoqué rejeté, PIN valide, PIN erroné 5 fois → verrouillage), rechargement complet de la page hors ligne (vérification Service Worker + persistance IndexedDB), retour `online`, synchronisation automatique et rejeu volontaire de la requête réseau → 0 perte, 0 doublon.
- Révocation à distance d'une tablette déclarée volée → rejet immédiat de toute synchronisation ultérieure et effacement du cache local à la première tentative de contact.

### 4.5 Connecteurs biométriques (3 paliers distincts)

| Palier | Environnement | Méthode | Statut maximum atteignable |
|---|---|---|---|
| **Palier 1 — Émulation** | CI / Sandbox | Simulateur envoyant des requêtes protocolaires synthétiques, corruptions, rejeux, horloges décalées et pics de charge (`is_simulated = true`). | `SIMULATED` |
| **Palier 2 — Conformité protocolaire** | CI / Docker | Tests unitaires et d'intégration du vrai connecteur sur corpus de trames réelles anonymisées (ADMS, ISAPI, TCP, gRPC), gestion d'erreurs réseau, timeouts et DLQ RabbitMQ. | `PROTOCOL_IMPLEMENTED` |
| **Palier 3 — Homologation physique** | Labo + Staging HTTPS | Exécution manuelle et instrumentée des **12 tests d'homologation** définis dans `BIOMETRIC_INTEGRATION_PLAN.md` sur véritable pointeuse physique, avec procès-verbal daté listant modèle exact et version de firmware. | `LAB_VALIDATED` puis `PRODUCTION_CERTIFIED` |

### 4.6 Tests de performance et de résilience (k6 & Chaos)

- **Pic d'embauche du matin** : injection simultanée de 500 pointages/s pendant 5 minutes sur `device-gateway` → 0 erreur 5xx, P95 d'acquittement < 150 ms, résorption complète de la file RabbitMQ sans perte.
- **Clôture de fin de mois** : calcul simultané de la paie de 5 entreprises totalisant 5 000 agents → respect des SLA mémoire/CPU, aucune interférence inter-tenant, génération complète des PDF.
- **Pannes d'infrastructure** : arrêt temporaire d'un worker en plein calcul de paie → reprise propre via non-acquittement RabbitMQ et idempotence, sans double ligne de bulletin ; restauration complète d'une sauvegarde PostgreSQL sur base vierge et vérification des sommes de contrôle.

---

## 5. Portes de qualité automatisées (CI/CD Quality Gates)

Aucune Pull Request ne peut être fusionnée si l'une des étapes suivantes échoue :

1. `pnpm lint` & vérification du formatage.
2. `pnpm typecheck` (`tsc --noEmit` en mode strict sur 100 % des apps et packages).
3. Vérification de sécurité : `pnpm audit` (zéro vulnérabilité critique/haute non traitée) + scan de secrets + règle statique interdisant les flottants financiers et les constantes fiscales codées en dur.
4. Tests unitaires et tests par propriétés (`packages/payroll-engine`, `packages/attendance-engine`, `packages/crypto-audit`, `packages/biometric-connectors`).
5. Tests d'intégration sur vrais conteneurs éphémères PostgreSQL 16 (migrations + RLS), Redis 7, RabbitMQ et MinIO S3 (dans GitHub Actions).
6. Suite obligatoire d'isolation multi-tenant et d'intégrité de la chaîne d'audit.
7. Tests E2E des parcours critiques (connexion MFA, création agent + badge QR, pointage kiosque offline/online, cycle complet de paie et génération bulletin PDF).
8. Build de production complet (`next build`, `nest build`) sans avertissement bloquant.
