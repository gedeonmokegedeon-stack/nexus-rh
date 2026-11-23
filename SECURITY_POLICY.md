# POLITIQUE DE SÉCURITÉ ET CONFORMITÉ BIOMÉTRIQUE — NEXUS RH

## 1. Objectifs de sécurité

**NEXUS RH** traite trois catégories d'actifs à très haute sensibilité :

1. **Données biométriques** (gabarits d'empreintes digitales et de reconnaissance faciale) — données sensibles irrévocables par nature (un agent ne peut pas « changer d'empreinte digitale » comme il change un mot de passe).
2. **Données financières et salariales** (rémunérations, impôts, cotisations, coordonnées bancaires et Mobile Money, ordres de virement).
3. **Données personnelles RH** (identité, famille, santé/congé maladie, dossier disciplinaire, contrats).

La présente politique applique les principes de **Security by Design**, **Privacy by Design**, **Zero Trust**, **moindre privilège** et **défense en profondeur**.

---

## 2. Gouvernance et sécurisation du dépôt GitHub

> **DÉCISION VALIDÉE (17 novembre 2026)** : le dépôt `gedeonmokegedeon-stack/nexus-rh` est placé sous **licence propriétaire commerciale — tous droits réservés** et doit impérativement être configuré en visibilité **PRIVÉE** (`isPrivate: true`), avec protection de la branche `main`, détection automatique de secrets (*GitHub Secret Scanning*) et Dependabot.
>
> *Note technique d'exécution* : l'intégration GitHub de l'environnement Arena ne disposant pas de la permission d'administration `PATCH /repos/{owner}/{repo}` (retour HTTP `403 Resource not accessible by integration`), le basculement effectif en **Privé** s'effectue directement par le propriétaire du projet dans **GitHub → Settings → General → Danger Zone → Change repository visibility → Change to private**. Tant que ce basculement n'est pas confirmé et qu'aucune autorisation de publication n'est donnée, aucun `git push` n'est exécuté vers le dépôt distant.

---

## 3. Cadre légal et conformité aux données biométriques en RDC

### 3.1 Textes de référence applicables en RDC

1. **Constitution de la République Démocratique du Congo** (18 février 2006, révisée) — notamment l'article 31 garantissant le droit au respect de la vie privée et au secret des communications.
2. **Ordonnance-Loi n° 23/010 du 13 mars 2023 portant Code du Numérique** — en particulier le **Livre III relatif à la protection des données à caractère personnel**, qui encadre :
   - les principes de licéité, loyauté, transparence, finalité déterminée, proportionnalité/minimisation, exactitude, limitation de conservation et sécurité/confidentialité ;
   - le régime renforcé des **données sensibles**, incluant explicitement les **données biométriques** utilisées aux fins d'identifier une personne physique de manière unique ;
   - les formalités préalables (déclaration / demande d'autorisation) auprès de l'**Autorité de Protection des Données (APD)** (et, à titre transitoire, de l'autorité compétente désignée par le ministère ayant le numérique dans ses attributions) ;
   - l'encadrement strict de l'hébergement et du **transfert transfrontalier** de données personnelles hors du territoire de la RDC (exigence d'un niveau de protection adéquat, garanties contractuelles et autorisation requise) ;
   - l'obligation de tenir un registre des traitements, de réaliser une analyse d'impact (AIPD) pour les traitements à risque élevé et de notifier toute violation de données à caractère personnel ;
   - les droits d'information, d'accès, de rectification, d'effacement, de limitation et d'opposition des personnes concernées.
3. **Code du Travail de la RDC** (Loi n° 015/2002 modifiée et complétée par la Loi n° 16/010 du 15 juillet 2016) — respect de la dignité du travailleur, règlement d'entreprise soumis au visa de l'Inspection du Travail, information de la délégation syndicale, conservation des pièces de paie et secret de la rémunération.

### 3.2 Répartition des responsabilités juridiques (SaaS)

- **L'entreprise cliente (Employeur / Tenant)** agit en qualité de **Responsable du traitement** vis-à-vis de ses agents (elle détermine la finalité du pointage et de la paie, recueille les consentements écrits, informe la délégation syndicale et accomplit ses formalités auprès de l'APD).
- **NEXUS RH (Éditeur / Opérateur SaaS)** agit en qualité de **Sous-traitant** (au sens du Code du Numérique) : il ne traite les données que sur instruction documentée du client, fournit nativement les garde-fous techniques de conformité, conclut un accord de sous-traitance des données (DPA) avec chaque client et assiste celui-ci dans ses obligations d'audit et de conformité.

### 3.3 Huit exigences techniques obligatoires intégrées dans NEXUS RH pour la biométrie

| # | Règle de conformité RDC | Traduction technique obligatoire dans NEXUS RH |
|---|---|---|
| 1 | **Consentement préalable, libre, éclairé et écrit** | La base de données et l'API bloquent techniquement toute création dans `biometric_templates` et toute commande d'enrôlement si l'agent ne possède pas un enregistrement `biometric_consents` au statut `GRANTED` accompagné du formulaire signé téléversé (`signed_form_document_id NOT NULL`). |
| 2 | **Alternative non biométrique obligatoire** | Tout agent peut refuser la biométrie, retirer son consentement ou être physiquement dans l'impossibilité d'utiliser ses empreintes (travaux manuels, handicap) sans aucune pénalité fonctionnelle : le pointage par **QR Code** et/ou **code PIN** reste toujours disponible à égalité de traitement. |
| 3 | **Stockage local sur terminal par défaut & interdiction absolue des images brutes** | **Décision propriétaire obligatoire** : par défaut, tous les tenants sont configurés en mode `DEVICE_ONLY` (`central_template_storage_enabled = false`) — les gabarits biométriques demeurent exclusivement dans l'enclave sécurisée des terminaux physiques. **Aucun stockage central de gabarits** dans `biometric_templates` n'est techniquement possible sans la réunion cumulative de trois verrous vérifiés en base et dans l'API : (a) référence d'autorisation juridique enregistrée (`biometric_legal_authorization_ref`), (b) activation et validation explicite autorisée sur le tenant, et (c) consentement écrit signé actif de l'agent. En toutes circonstances, **aucune image brute** d'empreinte ou de visage n'est jamais stockée. |
| 4 | **Finalité exclusive et proportionnalité** | Les données biométriques servent uniquement à l'authentification de présence (et au contrôle d'accès autorisé sur le site). Aucune réutilisation commerciale, aucun profilage comportemental, aucune surveillance continue par caméra et aucun croisement inter-entreprises ne sont permis. |
| 5 | **Chiffrement d'enveloppe par entreprise** | Tout gabarit stocké dans `biometric_templates` est chiffré individuellement en **AES-256-GCM** avec une clé de données (DEK) unique, elle-même chiffrée par la clé maîtresse dédiée du tenant (KEK gérée par KMS/coffre-fort). Un dump brut de la base est cryptographiquement inexploitable. |
| 6 | **Droit de retrait et purge automatique en fin de contrat** | Le retrait du consentement ou le passage du contrat au statut `TERMINATED` déclenche automatiquement : (a) la suppression physique irréversible des lignes de `biometric_templates`, (b) l'envoi en priorité maximale (`priority = 1`) des commandes `DELETE_TEMPLATE` / `DELETE_USER` à tous les terminaux du tenant, et (c) l'émission d'un certificat horodaté de purge dans `biometric_consents` et `audit_logs`. |
| 7 | **Maîtrise de la localisation et des transferts** | Documentation transparente de la région d'hébergement, clauses contractuelles de protection, chiffrement de bout en bout et capacité architecturale de déploiement dans un datacenter situé en RDC pour les organisations soumises à une obligation stricte de résidence locale. |
| 8 | **Registre des traitements et AIPD** | Génération intégrée, par entreprise cliente, du registre des traitements biométriques (finalité, base légale, nombre d'agents enrôlés, modèles de terminaux, durées de rétention, mesures de sécurité, historique des purges) pour faciliter les démarches auprès de l'APD. |

---

## 4. Modèle de menaces (STRIDE) et contre-mesures

| Menace | Scénario concret | Contre-mesures intégrées |
|---|---|---|
| **Spoofing (Usurpation)** | Un tiers envoie de faux pointages HTTP en imitant une pointeuse ZKTeco ; un agent pointe avec la photo du badge QR d'un collègue. | Authentification forte par terminal (certificat mTLS ou secret par appareil + signature + liste blanche IP optionnelle + numéro de série appairé) ; QR Code signé révocable, mode QR dynamique rotatif TOTP, combinaison `QR + PIN`, terminaux faciaux avec détection du vivant (*liveness*). |
| **Tampering (Altération)** | Un utilisateur RH modifie en cachette des heures supplémentaires ou un bulletin de paie clôturé ; modification de l'horloge d'une tablette. | Immuabilité SQL des événements bruts et des paies `LOCKED` ; régularisations séparées avec motif et approbation hiérarchique ; comparaison systématique `device_local_timestamp` vs `received_at_utc` et alerte de dérive ; hachage SHA-256 des bulletins PDF et chaîne d'audit. |
| **Repudiation (Répudiation)** | Un gestionnaire nie avoir modifié un salaire, un compte bancaire ou un barème IPR. | Journal d'audit append-only chaîné SHA-256 enregistrant acteur, session, IP, valeurs avant/après, motif et MFA préalable (*step-up auth*) pour les actions critiques (changement RIB, approbation paie, modification de règles). |
| **Information Disclosure (Fuite)** | Un tenant accède aux bulletins d'un autre tenant ; vol d'une tablette kiosque ; compromission d'une sauvegarde. | Double isolation Guard + PostgreSQL `FORCE ROW LEVEL SECURITY` ; zéro donnée RH/salariale stockée sur la tablette kiosque (uniquement hachages de badges autorisés et file chiffrée) + révocation à distance instantanée ; chiffrement TLS 1.3, S3 SSE, sauvegardes chiffrées et AES-256-GCM par enveloppe sur gabarits et comptes bancaires. |
| **Denial of Service (Déni de service)** | Inondation de la passerelle biométrique ou attaque par force brute sur la connexion / les PIN. | Séparation physique de `device-gateway` et `api` ; WAF + rate limiting Redis multi-niveaux ; verrouillage progressif des comptes et codes PIN ; mise en file RabbitMQ absorbant les pics. |
| **Elevation of Privilege (Élévation)** | Un chef de site tente d'approuver la paie ; un comptable crée un agent fictif et valide seul sa paie. | RBAC + périmètre site vérifié côté serveur à chaque requête ; séparation stricte des tâches (SoD : création agent / calcul paie / approbation paie par acteurs distincts) ; interdiction d'auto-approbation. |

---

## 5. Authentification, gestion des sessions et autorisations

### 5.1 Authentification utilisateurs
- **Mots de passe** : minimum 12 caractères, vérification contre les listes de mots de passe compromis courants, hachage **Argon2id** (mémoire ≥ 64 MiB, itérations ≥ 3, parallélisme 1).
- **Codes PIN agents** : 6 chiffres par défaut (interdiction des séquences triviales `000000`, `123456`, année de naissance), hachés individuellement avec sel unique en **Argon2id**, verrouillage temporaire après 5 échecs consécutifs.
- **MFA (TOTP RFC 6238)** : obligatoire pour `SUPER_ADMIN`, `TENANT_ADMIN`, `PAYROLL_MANAGER`, `PAYROLL_APPROVER` et `BIOMETRIC_ADMIN` ; fortement recommandé et activable par politique d'entreprise pour tous les autres rôles. Codes de secours à usage unique hachés.
- **Jetons de session** :
  - *Access Token* JWT signé asymétriquement (`EdDSA` ou `RS256`), durée de vie courte (15 minutes), contenant `sub`, `tid` (`tenant_id`), `sid` (`session_id`), `jti` et `mfa`.
  - *Refresh Token* opaque à haute entropie (256 bits), transmis exclusivement par cookie `HttpOnly; Secure; SameSite=Strict`, rotation systématique à chaque utilisation et révocation automatique de toute la famille de jetons en cas de détection de réutilisation.
- **Ré-authentification (*Step-up MFA*)** : exigée avant la clôture d'un cycle de paie, l'export global des virements bancaires, la modification d'un barème fiscal/social, la création d'une clé API ou la purge/export massif de données.

### 5.2 Matrice des rôles standards (RBAC + SoD)

| Rôle standard | Périmètre type | Droits clés | Interdictions clés (SoD) |
|---|---|---|---|
| `SUPER_ADMIN` | Plateforme SaaS | Gestion tenants, abonnements, santé système, modèles réglementaires globaux | Pas d'accès silencieux aux salaires/biométrie d'un client (tout accès support exige une délégation temporaire autorisée par le client et auditée) |
| `TENANT_ADMIN` | Entreprise | Configuration société, sites, utilisateurs, rôles, sécurité, clés API | Ne peut pas effacer le journal d'audit |
| `HR_MANAGER` | Entreprise ou Sites | Agents, contrats, avenants, badges QR, consentements biométriques, horaires, congés, validation GTA | N'approuve pas seul la clôture financière de la paie |
| `PAYROLL_MANAGER` | Entreprise | Rubriques, variables de paie, prêts/avances, simulation et calcul de paie, déclarations | Ne peut pas approuver/clôturer le cycle qu'il a calculé (si SoD actif) ni modifier son propre bulletin |
| `FINANCE_APPROVER` | Entreprise | Contrôle des écarts, approbation et clôture de la paie, validation des ordres de virement, rapports DG | Ne saisit pas les pointages ni les contrats |
| `SITE_MANAGER` | Établissement(s) assigné(s) | Suivi présences site, planning équipe, validation congés N1, heures sup. et régularisations N1 | Aucun accès aux autres sites ni aux salaires |
| `BIOMETRIC_ADMIN` | Établissement(s) assigné(s) | Appairage terminaux/kiosques, supervision sync, enrôlement (si consentement actif) | Aucun accès aux salaires, contrats ou bulletins |
| `KIOSK_DEVICE` | 1 établissement unique | Envoi de pointages signés et téléchargement de la liste hachée des badges actifs du site | Aucun accès API utilisateur ou RH |
| `EMPLOYEE` | Soi-même uniquement | Consultation profil, badge QR, pointages, soldes, bulletins personnels ; demandes congés/acomptes | Aucun accès aux données d'autrui |
| `EXTERNAL_AUDITOR` | Entreprise (borné dans le temps) | Lecture seule des livres de paie, déclarations, présences validées et journaux d'audit | Aucune écriture, aucun accès aux gabarits biométriques |

---

## 6. Sécurité des appareils biométriques et des API externes

1. **Provisionnement sécurisé des terminaux** : un terminal inconnu ne peut jamais injecter de pointages. Il doit être pré-déclaré par son numéro de série et appairé via une clé secrète unique (ou certificat client mTLS pour `edge-agent` et protocoles compatibles).
2. **Protocole legacy ZKTeco ADMS** : certains anciens modèles ZKTeco ne supportent que HTTP en clair en natif. Règle stricte NEXUS RH :
   - Sur Internet public (WAN), **seuls les terminaux supportant HTTPS (TLS 1.2/1.3)** sont autorisés à se connecter directement à `device-gateway`.
   - Tout terminal ne supportant que HTTP ou TCP non chiffré (port 4370) doit obligatoirement passer par le **Nexus Edge Agent** sur le réseau local isolé (VLAN dédié pointage) ou par un tunnel VPN chiffré de site, qui chiffre ensuite le flux en TLS 1.3 vers le cloud.
3. **Anti-rejeu et intégrité** : horodatage signé, nonce/clé d'idempotence et rejet des requêtes hors fenêtre acceptable (sauf lots hors ligne explicitement signés et marqués `was_offline_queued = true`).
4. **Durcissement API** : en-têtes de sécurité stricts (`Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`), CORS sur liste blanche stricte, validation Zod avec rejet des champs inconnus, protection CSRF, pagination plafonnée (max 100 éléments par page).

---

## 7. Politique de conservation, de sauvegarde et de réponse aux incidents

### 7.1 Durées de conservation de référence (paramétrables selon obligations légales)

| Catégorie de données | Durée de conservation | Action à l'échéance |
|---|---|---|
| **Gabarits biométriques** | Durée d'activité du contrat tant que le consentement est actif | **Purge immédiate** au retrait du consentement ou à la fin du contrat (+ suppression sur terminaux) |
| **Preuve de consentement biométrique et certificat de purge** | 5 ans après la purge | Archivage restreint puis suppression |
| **Photos de contrôle kiosque (si option activée)** | 30 à 90 jours maximum (paramétrable) | Purge automatique S3 (*lifecycle rule*) |
| **Événements bruts de pointage** | 5 ans (prescription sociale/contentieux heures sup.) | Archivage froid chiffré puis purge |
| **Bulletins de paie, livres de paie, déclarations DGI/CNSS/INPP/ONEM** | 10 ans minimum (obligations comptables SYSCOHADA, fiscales et sociales) | Archivage immuable chiffré |
| **Journaux d'audit de sécurité** | 5 ans minimum | Archivage immuable vérifiable |

### 7.2 Gestion des secrets et de la chaîne logicielle
- Zéro secret dans Git, les Dockerfiles ou les logs applicatifs ; rotation périodique des clés API, secrets JWT et clés d'appareils ; fichier `.env.example` contenant uniquement des variables vides documentées.
- Verrouillage exact des dépendances (`pnpm-lock.yaml`), audit automatique des vulnérabilités CVE en CI, analyse statique de sécurité (SAST) et vérification d'intégrité de la chaîne d'audit par tâche planifiée quotidienne.

### 7.3 Procédure de gestion des violations de données
1. **Détection & confinement immédiat (< 1 h)** : révocation des jetons/clés/terminaux compromis, isolation du service ou du tenant concerné, préservation des preuves forensiques (`audit_logs`, logs réseau).
2. **Analyse d'impact (< 24 h)** : identification exacte des tenants, personnes et catégories de données touchées (vérification de l'état de chiffrement).
3. **Notification (< 72 h, ou délai plus court exigé par le Code du Numérique / contrat)** : notification circonstanciée au(x) client(s) responsable(s) du traitement afin d'assurer la notification à l'APD et aux agents concernés, accompagnée du plan de remédiation et d'un rapport post-incident complet.
