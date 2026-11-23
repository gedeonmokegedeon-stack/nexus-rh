# PLAN D'INTÉGRATION BIOMÉTRIQUE MULTI-MARQUES — NEXUS RH

## 1. Philosophie d'intégration et règle absolue de transparence

L'intégration de pointeuses physiques dans une plateforme SaaS cloud est un domaine où la rigueur d'ingénierie est décisive : chaque fabricant utilise ses propres protocoles réseau, ses propres firmwares, ses propres modes d'authentification et ses propres formats mathématiques de gabarits biométriques.

### Règle d'or NEXUS RH

> **Un connecteur simulé ou simplement codé d'après documentation n'est JAMAIS présenté comme une intégration biométrique opérationnelle.**

Chaque connecteur et chaque couple `(fabricant, famille de modèles, firmware)` porte dans le code, la base de données et l'interface utilisateur l'un des cinq statuts officiels suivants :

| Niveau | Code statut | Signification exacte | Autorisé en paie réelle ? |
|---|---|---|---|
| **0** | `SPECIFIED` | Architecture et protocole documentés, non encore codés *(état actuel — Mission 0)* | **Non** |
| **1** | `SIMULATED` | Émulateur logiciel de test permettant de vérifier la chaîne d'ingestion. Marqué `[SIMULATION]` partout (`is_simulated = true`). | **Non (bloqué en BDD)** |
| **2** | `PROTOCOL_IMPLEMENTED` | Connecteur réel implémenté et testé sur trames protocolaires conformes, en attente de test sur appareil physique. | **Non (pilote labo seul)** |
| **3** | `LAB_VALIDATED` | Testé et validé sur au moins une véritable pointeuse physique en laboratoire (procès-verbal signé). | **Pilote supervisé** |
| **4** | `PRODUCTION_CERTIFIED` | Homologué en conditions réelles multi-jours (coupure courant, coupure réseau, déduplication, charge, révocation, purge). | **Oui** |

---

## 2. Architecture des connecteurs indépendants (`packages/biometric-connectors`)

Le noyau métier de NEXUS RH (`apps/api`, `attendance-engine`, `payroll-engine`) **ignore totalement** la marque d'une pointeuse. Il ne manipule que des événements canoniques (`CanonicalAttendanceEvent`) et des commandes canoniques (`CanonicalDeviceCommand`).

```text
packages/biometric-connectors/
├── core/
│   ├── connector.interface.ts     # Contrat IBiometricConnector
│   ├── canonical-models.ts        # Événements, commandes, capacités, erreurs normalisées
│   ├── connector-registry.ts      # Registre dynamique + vérification statut de maturité
│   └── template-compatibility.ts  # Vérification stricte (vendor + modality + algo_version)
├── zkteco/
│   ├── zkteco-adms.connector.ts   # Mode Cloud Push (ICLOCK / ADMS HTTPS)
│   └── zkteco-lan.connector.ts    # Mode LAN (protocole TCP 4370 via Nexus Edge Agent)
├── hikvision/
│   ├── hikvision-isapi.connector.ts  # Mode ISAPI REST/Event Stream (Edge ou HTTPS)
│   └── hikvision-push.connector.ts   # Mode HTTP Listening / ISUP 5.0
├── anviz/
│   ├── anviz-cloud.connector.ts   # Mode CrossChex Cloud / WebSocket Push
│   └── anviz-tcp.connector.ts     # Mode LAN protocole binaire TCP 5010 (via Edge Agent)
├── suprema/
│   └── suprema-gsdk.connector.ts  # Mode Suprema G-SDK (gRPC/TLS) & BioStar 2 REST API
├── generic/
│   └── signed-file.connector.ts   # Import de secours audité (fichiers logs natifs USB)
└── simulator/                     # Strictement isolé — force is_simulated = true
    └── protocol-simulator.ts
```

### Contrat standard `IBiometricConnector`

Chaque connecteur implémente de manière isolée :
1. `getMetadata()` : fabricant, protocole, statut de maturité réel, modèles certifiés, capacités (`FINGERPRINT`, `FACE`, `RFID`, `QR`, `PIN`), support HTTPS natif.
2. `authenticateRequest(req, deviceContext)` : vérification cryptographique de l'identité du terminal.
3. `parseInboundEvents(rawPayload, deviceContext)` : transformation sans perte vers `CanonicalAttendanceEvent[]` + conservation de `raw_payload`.
4. `parseHeartbeat(rawPayload)` : extraction de l'état de santé, de la version firmware, de l'horloge locale et de l'occupation mémoire.
5. `encodeCommand(command)` & `parseCommandAck(rawAck)` : traduction des commandes canoniques (`UPSERT_USER`, `DELETE_USER`, `PUSH_TEMPLATE`, `DELETE_TEMPLATE`, `SYNC_TIME`, `FETCH_LOGS`) dans la syntaxe native du fabricant.
6. `canShareTemplate(sourceDevice, targetDevice)` : retourne `true` uniquement si fabricant, modalité et version exacte d'algorithme biométrique sont compatibles.

---

## 3. Modes de connectivité terrain (adaptés à la RDC)

| Mode | Fonctionnement | Cas d'usage idéal en RDC |
|---|---|---|
| **Mode A — Cloud Push direct (recommandé)** | La pointeuse initie elle-même des requêtes HTTPS sortantes vers `device-gateway` via routeur 4G, fibre ou Starlink/VSAT. Aucun port entrant ni IP fixe requis chez le client. | Bureaux, agences bancaires, cliniques, écoles, commerces équipés de terminaux récents compatibles Push HTTPS. |
| **Mode B — Nexus Edge Agent (LAN → Cloud)** | Un petit service local (sur PC dédié, mini-PC Linux ou serveur d'agence) dialogue en LAN avec une ou plusieurs pointeuses (TCP 4370, ISAPI, TCP 5010, G-SDK), stocke les pointages dans un tampon local chiffré et pousse en HTTPS/mTLS vers le cloud dès qu'Internet est disponible. | Pointeuses anciennes sans mode Cloud Push ou sans HTTPS natif ; sites miniers, usines, entrepôts à connexion instable ; multi-pointeuses sur VLAN sécurisé. |
| **Mode C — PWA Kiosque Tablette (Offline-First)** | Tablette Android/iPad fixée au mur ou tenue par le chef de chantier, scannant les badges QR Codes signés et/ou codes PIN, avec file locale chiffrée IndexedDB ≥ 72 h. | Démarrage immédiat sans pointeuse, chantiers BTP mobiles, antennes ONG, postes de garde, mode de secours en cas de panne. |
| **Mode D — Import USB signé de secours** | Extraction du fichier journal natif de la pointeuse sur clé USB et téléversement contrôlé dans NEXUS RH (avec déduplication et traçabilité d'audit `USB_IMPORT`). | Sites totalement coupés d'Internet pendant plusieurs semaines. |

---

## 4. Règle technique et juridique fondamentale sur les gabarits biométriques

1. **Stockage local sur le terminal par défaut (`DEVICE_ONLY` — décision propriétaire validée)** : par défaut, NEXUS RH ne remonte et ne stocke **aucun gabarit biométrique** dans la base de données centrale ; les gabarits restent exclusivement dans la mémoire sécurisée des pointeuses physiques, et seuls les événements de pointage horodatés remontent au serveur. Tout stockage central de gabarits chiffrés est techniquement bloqué tant que ne sont pas réunis : (a) une autorisation juridique formelle référencée, (b) un consentement écrit signé de l'agent, et (c) une validation explicite sur l'entreprise. Une méthode alternative non biométrique (**QR Code / PIN**) est toujours disponible.
2. **La reconnaissance (matching 1:N / 1:1) s'exécute sur le terminal physique certifié**, équipé de son capteur d'empreinte optique/capacitif ou de sa double caméra IR/lumière visible anti-fraude (*anti-spoofing*).
3. **Non-interopérabilité inter-marques** : un gabarit d'empreinte ZKTeco (`ZKFinger v10/v12`) ne peut pas être lu par un terminal Hikvision ou Suprema ; de même, un gabarit facial varie selon la génération d'algorithme d'un même fabricant.
4. **Conséquence pratique gérée nativement par NEXUS RH** :
   - En mode standard (`DEVICE_ONLY`), l'agent est enrôlé directement sur le terminal de son site d'affectation (après consentement enregistré) ; aucun gabarit ne quitte le terminal.
   - Sur un parc homogène (ex. 5 terminaux ZKTeco SpeedFace-V5L de même génération), la synchronisation chiffrée AES-256-GCM entre terminaux compatibles n'est possible **que** si les trois conditions juridiques et administratives ci-dessus ont été préalablement validées.
   - Sur un parc mixte (ex. ZKTeco au siège de Kinshasa et Hikvision à l'entrepôt de Lubumbashi), l'agent conserve **un seul matricule et un seul dossier RH** dans NEXUS RH : ses pointages remontent dans le même journal unifié quelle que soit la marque, et il dispose en permanence de son badge QR Code / code PIN universel.

---

## 5. Feuille de route par fabricant (ordre officiel validé)

### Vague 1A — PWA Kiosque Tablette (QR Code + PIN)
- **Priorité** : Immédiate (zéro dépendance à un protocole propriétaire).
- **Modalités** : QR Code statique signé, QR Code dynamique rotatif (TOTP), code PIN Argon2id, combinaison `QR + PIN`, géorepérage GPS optionnel.

### Vague 1B — ZKTeco *(Priorité matérielle n° 1 — marque la plus répandue en RDC)*
- **Protocoles** :
  1. **ADMS / ICLOCK Push** (HTTP/HTTPS : `/iclock/cdata`, `/iclock/getrequest`, `/iclock/devicecmd`, `/iclock/ping`) pour la connexion directe au cloud.
  2. **ZKProtocol TCP 4370** via *Nexus Edge Agent* pour les modèles d'entrée de gamme dépourvus de licence ADMS.
- **Modalités** : Empreinte digitale (`ZKFinger v10/v12`), reconnaissance faciale lumière visible (*Visible Light*), badge RFID, code PIN, QR Code (selon modèle).
- **Gammes de modèles cibles** : `SenseFace 2A / 3A / 4A`, `SpeedFace-V5L` (empreinte + visage + paume + ADMS HTTPS), `MB360 / MB460` (avec option ADMS), `iClock 880 / uFace`, `WL20 / K40 Pro` (vérifier impérativement la présence du menu *Cloud Server Setting / ADMS*).
- **Points de vigilance connus** : présence ou non de la fonction ADMS selon le firmware, activation HTTPS sur firmwares récents (sinon passage obligatoire par Edge Agent), gestion stricte du fuseau horaire (`UTC+1` vs `UTC+2`), idempotence lors de la retransmission de logs après coupure.

### Vague 2 — Hikvision *(Priorité matérielle n° 2 — très forte présence en RDC)*
- **Protocoles** :
  1. **ISAPI** (REST sur HTTPS, authentification Digest / TLS, payloads JSON & XML, flux d'événements `AccessControllerEvent`, gestion utilisateurs `UserInfo` et empreintes/visages `FingerPrintCfg` / `FDLib`).
  2. **HTTP Listening (Push d'événements)** et/ou **ISUP 5.0** pour la remontée WAN sans IP fixe côté client.
- **Modalités** : Reconnaissance faciale double objectif anti-spoofing (gamme *MinMoe*), empreinte digitale, carte Mifare/DESFire, QR Code, PIN.
- **Gammes de modèles cibles** : `DS-K1T341AMF`, `DS-K1T342MFWX`, `DS-K1T343MFWX`, `DS-K1T671M`, `DS-K1T804BMF` (empreinte + carte + PIN).
- **Points de vigilance connus** : authentification HTTP Digest stricte, différences de capacités ISAPI selon modèle (vérification dynamique via `/ISAPI/AccessControl/capabilities`), interdiction de stocker les photos d'événements faciales si le client n'a pas activé et légalement encadré cette option.

### Vague 3 — Anviz *(Priorité matérielle n° 3)*
- **Protocoles** : protocole Push Cloud / WebSocket Anviz et protocole binaire TCP/IP (port `5010`, trames avec CRC16) via *Nexus Edge Agent*.
- **Modalités** : Empreinte (*BioNANO*), reconnaissance faciale (*FaceDeep*), RFID, PIN.
- **Gammes de modèles cibles** : `FaceDeep 3 / FaceDeep 5`, `C2 Pro`, `W1 Pro`, `EP300 Pro`.

### Vague 4 — Suprema *(Priorité matérielle n° 4 — segment banques, mines, grands comptes)*
- **Protocoles** : **Suprema G-SDK** (gRPC bidirectionnel sur TLS 1.3 via Device Gateway officiel) et/ou intégration **BioStar 2 REST API + WebSocket**.
- **Modalités** : Empreinte haute sécurité (certifications FBI PIV / ISO 19794-2 selon modèle), reconnaissance faciale Fusion (`BioStation 3`, `FaceStation F2`), RFID multi-fréquence, QR/Mobile Access, PIN.
- **Gammes de modèles cibles** : `BioStation 3`, `FaceStation F2`, `BioEntry W2 / P2`, `BioLite N2`.

### Vague 5 — Autres fabricants (extensibilité)
- **Dahua** (terminaux ASI — CGI API / Auto-Register), **FingerTec**, **IDEMIA (Morpho)** ou tout terminal exposant une API REST/Webhook documentée, via l'ajout d'un nouveau dossier dans `packages/biometric-connectors/` sans toucher au reste de la plateforme.

---

## 6. Gestion des aléas opérationnels (terrain RDC)

1. **Coupures électriques (délestages)** : recommandation systématique d'un mini-onduleur DC 12 V (autonomie 4 à 8 h, très abordable) ou de modèles à batterie intégrée ; conservation non volatile des logs dans la mémoire flash du terminal (typiquement 50 000 à 200 000 événements).
2. **Coupures Internet prolongées** : le terminal ou le *Nexus Edge Agent* accumule les pointages horodatés localement ; au retour de la liaison, les lots sont ingérés dans l'ordre chronologique, dédupliqués par `idempotency_key` et déclenchent automatiquement le recalcul des journées concernées (tant que la paie du mois n'est pas clôturée).
3. **Empreintes illisibles ou usées** (manutention, BTP, mines, personnel soignant, humidité) : possibilité par agent d'enrôler plusieurs doigts, d'utiliser la reconnaissance faciale sans contact sur terminal compatible, ou d'utiliser son badge QR Code + PIN sans blocage.
4. **Dérive de l'horloge du terminal** : calcul automatique de `clock_drift_seconds` à chaque heartbeat ; au-delà de 60 s d'écart, émission d'une commande `SYNC_TIME` et alerte administrateur ; au-delà de 10 min, mise en quarantaine d'anomalie pour vérification avant impact paie.

---

## 7. Prérequis matériels et réseau pour homologuer de véritables pointeuses

> *Conformément aux règles de la Mission 0, aucun matériel ni service ne doit être acheté sans décision du propriétaire. La liste ci-dessous définit le banc d'essai minimal nécessaire au moment d'aborder la Mission 5 (et les vagues suivantes).*

### 7.1 Banc d'essai minimal recommandé (Vague 1 — MVP opérationnel)

| Équipement | Spécification recommandée | Rôle dans les tests |
|---|---|---|
| **1 Pointeuse ZKTeco hybride** | Ex. **ZKTeco SenseFace 2A/3A** ou **SpeedFace-V5L** — **impérativement avec firmware ADMS (Cloud Server) et support HTTPS**, capteur d'empreinte + reconnaissance faciale + PIN | Validation réelle de l'empreinte, du visage, du PIN et du protocole ADMS Push HTTPS (Vague 1B). |
| **1 Tablette Android standard** | Android 11+, écran 8" à 10", caméra arrière + avant, 4 Go RAM, Wi-Fi + carte SIM 4G | Validation réelle de la PWA Kiosque (QR Code + PIN, mode avion 24 h, reprise réseau, autonomie). |
| **1 Alimentation 12 V DC + mini-onduleur DC** | Mini-UPS 12 V / 2 A (type routeur/pointeuse) | Test réel de coupure secteur sans interruption et de redémarrage propre après épuisement batterie. |
| **1 Routeur Ethernet/Wi-Fi + connexion 4G** | Switch/routeur standard + SIM data locale | Reproduction fidèle d'un site client en RDC (NAT, IP dynamique, coupure WAN volontaire, latence mobile). |
| **1 Poste local (PC existant ou mini-PC)** | Windows 10/11 ou Linux (4 Go RAM), connecté au même LAN que la pointeuse | Test réel du *Nexus Edge Agent* en mode LAN et capture diagnostic des trames réseau. |
| **1 Environnement Staging Cloud HTTPS** | Sous-domaine dédié (ex. `devices-staging.nexus-rh...`) avec certificat TLS valide | Indispensable car une vraie pointeuse ne peut pas cibler durablement un sandbox de développement éphémère. |
| **Lot de 5 à 10 badges imprimés** | Cartes PVC ou badges plastifiés avec QR Codes générés par NEXUS RH (+ cartes RFID Mifare 13,56 MHz si test RFID) | Validation réelle de la vitesse de lecture, de la révocation et de l'anti-fraude. |

### 7.2 Extensions du banc d'essai pour les vagues ultérieures
- **Vague 2 (Hikvision)** : 1 terminal **Hikvision MinMoe** (ex. `DS-K1T341AMF` ou `DS-K1T342MFWX` — visage + empreinte + carte + ISAPI/ISUP).
- **Vague 3 (Anviz)** : 1 terminal **Anviz** (ex. `C2 Pro` ou `FaceDeep 3`) + accès à la documentation officielle du protocole SDK/Cloud Anviz.
- **Vague 4 (Suprema)** : 1 terminal **Suprema** (ex. `BioLite N2` ou `BioStation 3`) + SDK officiel Suprema G-SDK / licence d'essai BioStar 2.

### 7.3 Protocole d'homologation obligatoire en 12 points (passage à `PRODUCTION_CERTIFIED`)
1. Appairage sécurisé initial et rejet d'un numéro de série / secret invalide.
2. Synchronisation descendante de 50 agents de test (création, modification de nom, attribution PIN).
3. Blocage d'enrôlement sans consentement actif, puis enrôlement réel d'empreintes et de visage (par volontaires de l'équipe de test ayant signé un consentement de test).
4. Pointages réels `CHECK_IN` / `CHECK_OUT` par empreinte, visage et PIN ; vérification de la réception en < 5 s.
5. Test du double fuseau horaire : configuration site `Africa/Kinshasa` puis `Africa/Lubumbashi`, vérification d'exactitude à la seconde près.
6. Test anti-rebond (3 passages en 30 secondes → 3 bruts conservés, 1 seul retenu en GTA).
7. Test coupure Internet (débranchement WAN, 30 pointages hors ligne, reconnexion → 30 pointages reçus, 0 perte, 0 doublon).
8. Test coupure électrique brutale puis redémarrage → intégrité mémoire, resynchronisation horaire et reprise des heartbeats.
9. Test de dérive d'horloge provoquée (+15 minutes sur l'appareil) → détection, alerte et commande `SYNC_TIME`.
10. Test de suspension / fin de contrat d'un agent → révocation effective de l'accès sur la pointeuse physique.
11. Test de retrait du consentement biométrique → suppression vérifiée en base **et** échec effectif du pointage par empreinte/visage sur la pointeuse, suivi d'un pointage réussi par PIN/QR.
12. Test d'endurance sur 72 heures continues → stabilité mémoire, 0 fuite de connexion, procès-verbal d'homologation archivé dans `docs/`.
