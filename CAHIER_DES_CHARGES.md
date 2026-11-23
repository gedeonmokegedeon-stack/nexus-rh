# CAHIER DES CHARGES — NEXUS RH

## 1. Objet et périmètre du document

Le présent cahier des charges définit de manière exhaustive les exigences fonctionnelles (`RF`) et non fonctionnelles (`RNF`) de la plateforme SaaS **NEXUS RH**. Il constitue le référentiel contractuel de conception pour l'ensemble des phases de développement, de test et d'homologation.

### Convention de priorité (méthode MoSCoW)

- **P0 (Indispensable — MVP commercialisable)** : requis avant toute mise en production cliente.
- **P1 (Important — V1 complète)** : requis pour couvrir les entreprises multi-sites et les parcs biométriques hétérogènes.
- **P2 (Évolutif — V2 Enterprise)** : différenciateurs avancés pour grands comptes, cabinets et écosystème partenaires.

---

## 2. Exigences fonctionnelles

### Module M01 — Plateforme SaaS, Entreprises (Tenants) et Établissements

| ID | Exigence | Priorité |
|---|---|---|
| `RF-M01-01` | **Gestion multi-entreprises (tenants)** : création, activation, suspension (sans suppression immédiate des données), réactivation et résiliation encadrée d'une entreprise cliente avec export de réversibilité. | P0 |
| `RF-M01-02` | **Identité légale de l'entreprise (RDC)** : raison sociale, sigle, forme juridique (SARL, SA, SAS, Établissement, ASBL/ONG, Établissement public), RCCM, Identification Nationale (Id. Nat.), Numéro Impôt (NIF/DGI), numéro d'affiliation CNSS, numéro INPP, numéro ONEM, secteur d'activité, effectif déclaré, logo, cachet/signature autorisée, coordonnées et adresses. | P0 |
| `RF-M01-03` | **Gestion multi-établissements / multi-sites** : chaque entreprise peut créer plusieurs établissements (siège, succursale, agence, usine, entrepôt, site minier, chantier, hôpital, campus) avec code unique, adresse, province RDC, ville, coordonnées GPS et rayon de géorepérage (*geofencing*) optionnel. | P0 |
| `RF-M01-04` | **Fuseau horaire par établissement** : chaque établissement définit explicitement son fuseau IANA (notamment `Africa/Kinshasa` UTC+1 et `Africa/Lubumbashi` UTC+2). Tous les calculs d'horaires, de retards et d'heures de nuit s'effectuent dans le fuseau local du site d'affectation. | P0 |
| `RF-M01-05` | **Organigramme et référentiels RH** : gestion hiérarchique des directions, départements, services, équipes, postes de travail, centres de coûts / projets analytiques (pour ONG/BTP/mines) et grille des catégories/échelons professionnels (classification des emplois RDC). | P0 |
| `RF-M01-06` | **Plans d'abonnement et quotas SaaS** : gestion paramétrable des offres, limites (nombre d'agents actifs, d'établissements, de terminaux biométriques, de stockage S3, modules activés), période d'essai et suivi de facturation SaaS. | P1 |
| `RF-M01-07` | **Mode Cabinet / Groupe** : possibilité pour un utilisateur habilité (ex. expert-comptable ou DRH de groupe) de basculer entre plusieurs entreprises autorisées avec changement explicite de contexte tenant et journalisation. | P2 |

---

### Module M02 — Gestion des Agents, Contrats, Matricules et QR Codes

| ID | Exigence | Priorité |
|---|---|---|
| `RF-M02-01` | **Dossier complet de l'agent** : état civil, sexe, date et lieu de naissance, nationalité, statut résident/expatrié (déterminant pour l'IERE), situation matrimoniale, pièces d'identité (carte d'électeur, passeport, carte de travail expatrié avec alerte d'expiration), photo d'identité, contacts, personne à prévenir en cas d'urgence, numéro d'immatriculation CNSS individuel, NIF individuel si applicable. | P0 |
| `RF-M02-02` | **Personnes à charge** : gestion des conjoint(e) et enfants/personnes légalement à charge avec pièces justificatives (actes de mariage, actes de naissance, certificats de scolarité/médicaux), dates de validité et calcul automatique du nombre de personnes à charge éligibles aux allocations familiales et à la réduction IPR. | P0 |
| `RF-M02-03` | **Coordonnées de paiement** : prise en charge du paiement par virement bancaire (banque, agence, compte CDF et/ou USD, RIB/SWIFT), Mobile Money (M-Pesa, Airtel Money, Orange Money, Afrimoney) ou espèces (caisse avec émargement), incluant la répartition éventuelle sur plusieurs comptes/devises. | P0 |
| `RF-M02-04` | **Génération automatique des matricules** : format paramétrable par entreprise (ex. `{CODE_ENT}-{CODE_SITE}-{ANNEE}-{SEQ:5}` ou `{PREFIX}{SEQ:6}`), garantie d'unicité stricte atomique (sans collision concurrente), conservation historique inaltérable et non-réattribution d'un matricule désactivé. | P0 |
| `RF-M02-05` | **Génération automatique des QR Codes et badges** : génération automatique d'un identifiant de badge cryptographiquement signé (jamais le simple matricule en clair) à l'embauche, édition PDF prête à imprimer de cartes professionnelles (format CR80 recto/verso personnalisable), révocation instantanée en cas de perte/vol/départ et réémission tracée. | P0 |
| `RF-M02-06` | **QR Code dynamique anti-fraude (optionnel)** : sur le portail mobile de l'agent, génération d'un QR Code temporaire rotatif signé (fenêtre paramétrable, ex. 30–60 s) empêchant le pointage par photo ou photocopie d'un badge statique. | P1 |
| `RF-M02-07` | **Gestion des contrats de travail** : CDI, CDD (suivi du terme, compteur de renouvellements, alertes d'échéance à J-60/J-30/J-15), contrat journalier (suivi du plafond légal de jours travaillés sur 2 mois avec alerte de requalification), stage, apprentissage et contrat de prestation. Gestion de la période d'essai et des alertes de fin d'essai. | P0 |
| `RF-M02-08` | **Mouvements et historique de carrière** : avenants, promotions, changements de catégorie/échelon, révisions salariales, mutations inter-établissements (avec transfert automatique d'affectation de pointage et de fuseau), détachements, suspensions (maladie longue durée, mise à pied, disponibilité) et fin de contrat (démission, licenciement, fin CDD, retraite, décès). | P0 |
| `RF-M02-09` | **Coffre-fort documentaire S3** : téléversement sécurisé, typage, versionnement, date d'expiration et consultation par URL pré-signée des pièces RH (contrat signé, visa, aptitude médicale, diplômes, avertissements, consentement biométrique signé). | P0 |
| `RF-M02-10` | **Import en masse contrôlé** : assistant d'import Excel/CSV des agents et contrats avec validation stricte ligne par ligne, rapport d'anomalies détaillé, prévisualisation et exécution transactionnelle journalisée. | P1 |

---

### Module M03 — Pointage Multi-Modal (Empreinte, Visage, QR Code, PIN)

| ID | Exigence | Priorité |
|---|---|---|
| `RF-M03-01` | **Pointage par empreinte digitale** : enrôlement de 1 à 10 doigts par agent (après enregistrement du consentement écrit) sur terminal biométrique compatible, identification 1:N ou vérification 1:1 sur l'appareil, réception horodatée de l'événement avec modalité `FINGERPRINT`. | P0 |
| `RF-M03-02` | **Pointage par reconnaissance faciale** : prise en charge des événements de reconnaissance faciale (`FACE`) produits par les terminaux biométriques compatibles dotés de capteurs anti-usurpation (*liveness detection* IR / double optique / lumière visible), avec indication du modèle d'appareil source. | P1 |
| `RF-M03-03` | **Pointage QR Code sur tablette / smartphone (PWA Kiosque)** : application PWA dédiée permettant le scan rapide par caméra du badge QR Code signé (statique ou dynamique), fonctionnement hors ligne (file locale chiffrée IndexedDB), synchronisation automatique au retour réseau, retour visuel/sonore immédiat et blocage des badges révoqués ou inactifs. | P0 |
| `RF-M03-04` | **Pointage par code PIN** : saisie du matricule (ou scan badge) + code PIN personnel (6 chiffres par défaut, haché Argon2id, jamais stocké en clair) sur terminal physique ou tablette PWA Kiosque, avec verrouillage temporaire après échecs répétés. Obligatoire comme alternative légale pour les agents sans biométrie. | P0 |
| `RF-M03-05` | **Authentification multi-facteurs au pointage (optionnelle par site)** : possibilité d'exiger `QR Code + PIN`, `Badge + Empreinte` ou `QR Code + prise de photo de contrôle` (soumise à consentement et rétention courte paramétrable) sur les sites sensibles. | P1 |
| `RF-M03-06` | **Types de pointage et inférence intelligente** : gestion des événements `CHECK_IN` (entrée), `CHECK_OUT` (sortie), `BREAK_START` (début pause), `BREAK_END` (fin pause), ainsi que l'appariement automatique entrée/sortie lorsque le terminal n'envoie qu'un pointage neutre, y compris sur les vacations de nuit franchissant minuit. | P0 |
| `RF-M03-07` | **Anti-rebond et déduplication** : filtrage configurable des doubles scans accidentels (ex. deux passages en moins de 3 minutes) sans jamais supprimer l'événement brut dans la table d'ingestion. | P0 |
| `RF-M03-08` | **Pointage manuel et régularisation encadrée** : en cas d'oubli de pointage, panne matérielle ou mission externe, saisie d'une régularisation avec motif obligatoire, pièce justificative optionnelle, circuit de validation hiérarchique et distinction visuelle permanente par rapport à un pointage matériel authentique. | P0 |
| `RF-M03-09` | **Contrôles anti-fraude** : détection d'écart entre l'horloge du terminal/tablette et l'heure serveur UTC, vérification du jeton d'enrôlement du kiosque, géorepérage GPS optionnel pour les tablettes mobiles de chantier et alerte en cas de pointages physiquement impossibles sur deux sites distants. | P1 |

---

### Module M04 — Parc Biométrique Multi-Marques et Synchronisation

| ID | Exigence | Priorité |
|---|---|---|
| `RF-M04-01` | **Inventaire des terminaux et kiosques** : enregistrement par établissement avec numéro de série unique, fabricant, modèle, version de firmware, capacités déclarées (empreinte, visage, carte RFID, QR, PIN), mode de communication (Cloud Push ou Edge Agent LAN), fuseau horaire et statut opérationnel. | P0 |
| `RF-M04-02` | **Architecture de connecteurs indépendants** : isolation stricte d'un module connecteur par fabricant, permettant d'activer progressivement **ZKTeco** (priorité 1), **Hikvision** (priorité 2), **Anviz** (priorité 3), **Suprema** (priorité 4) et d'autres fabricants sans modifier le noyau métier. | P0 |
| `RF-M04-03` | **Affichage honnête du niveau de maturité** : chaque connecteur et modèle de terminal affiche son statut réel (`SPECIFIED`, `SIMULATED`, `PROTOCOL_IMPLEMENTED`, `LAB_VALIDATED`, `PRODUCTION_CERTIFIED`). Tout événement issu d'un simulateur porte le marqueur indélébile `is_simulated = true` et est exclu de tout calcul de paie réelle. | P0 |
| `RF-M04-04` | **Synchronisation bidirectionnelle résiliente** : remontée automatique des pointages (temps réel ou différé après coupure réseau) et descente par file de commandes persistante des profils agents autorisés, révocations immédiates (départ/suspension), gabarits compatibles (même fabricant et même version d'algorithme) et synchronisation horaire. | P0 |
| `RF-M04-05` | **Supervision de santé du parc** : tableau de bord en temps réel des battements de cœur (*heartbeats*), date de dernière synchronisation, volume de commandes en attente, taux de remplissage mémoire, dérive d'horloge et alertes automatiques lorsqu'un terminal est hors ligne au-delà d'un seuil paramétrable. | P1 |
| `RF-M04-06` | **Passerelle locale Nexus Edge Agent** : agent logiciel léger installable sur un poste/mini-serveur local d'un site client pour interroger les pointeuses uniquement compatibles réseau local (LAN) et acheminer les pointages chiffrés vers le cloud NEXUS RH avec mise en tampon locale hors ligne. | P1 |
| `RF-M04-07` | **Import de secours audité (clé USB terminal)** : en cas de coupure Internet prolongée sur un site isolé, import contrôlé des fichiers journaux natifs exportés d'une pointeuse (ex. `.dat` ZKTeco), avec contrôle de cohérence, déduplication et marquage de la source `USB_IMPORT`. | P1 |

---

### Module M05 — Gestion des Horaires, Retards, Absences et Congés (GTA)

| ID | Exigence | Priorité |
|---|---|---|
| `RF-M05-01` | **Modèles d'horaires et vacations (shifts)** : horaires fixes hebdomadaires (ex. Lun–Ven 08h00–16h30 + Sam 08h00–12h00, base légale 45 h ou conventionnelle), horaires flexibles, vacations postées (matin, après-midi, nuit), cycles rotatifs (2×8, 3×8, 4×2, rotation minière 14j/14j ou 28j/14j, gardes hospitalières 24 h) et temps partiel. | P0 |
| `RF-M05-02` | **Règles de tolérance et de retards** : franchise de retard paramétrable (ex. 5 ou 10 min), paliers de retard, départs anticipés, pauses rémunérées ou non, règles d'arrondi paramétrables et seuils d'alerte disciplinaire (ex. X retards sur le mois). | P0 |
| `RF-M05-03` | **Gestion des heures supplémentaires et de nuit** : détection automatique des dépassements d'horaire, distinction entre heures simplement constatées et heures supplémentaires **autorisées/validées** par le manager (pour éviter les heures sup. non sollicitées), ventilation automatique par tranche de majoration paramétrable (ex. 6 premières heures, suivantes, repos hebdomadaire, jour férié, heures de nuit). | P0 |
| `RF-M05-04` | **Calendrier des jours fériés** : gestion paramétrable des jours fériés légaux en RDC, des ponts/chômés par décret ou décision officielle (y compris report lorsqu'un férié tombe un dimanche) et des calendriers spécifiques par province ou par établissement. | P0 |
| `RF-M05-05` | **Détection et qualification des absences** : identification quotidienne automatique de toute absence sur un jour ouvré planifié, file d'anomalies à qualifier (absence injustifiée, maladie justifiée, mission, formation, permission exceptionnelle, congé, mise à pied, grève, chômage technique) avec impact paramétrable sur la paie. | P0 |
| `RF-M05-06` | **Gestion complète des congés** : paramétrage des types de congés (annuel légal avec majoration d'ancienneté, maternité, circonstances familiales — mariage, naissance, décès —, maladie, récupération, sans solde), calcul mensuel automatique des droits acquis, gestion des reports et plafonds, demande depuis le portail agent avec justificatif, contrôle de chevauchement d'équipe et workflow d'approbation multi-niveaux (Manager → RH). | P0 |
| `RF-M05-07` | **Clôture mensuelle des temps (pré-paie)** : écran de synthèse et de validation des variables de temps par établissement (jours prestés, jours d'absence déductibles, retards déductibles, heures sup. validées par tranche, heures de nuit, primes de panier/transport liées aux jours effectivement prestés), verrouillage et transfert atomique vers le cycle de paie. | P0 |

---

### Module M06 — Paie Complète, Cotisations, Fiscalité RDC et Bulletins

| ID | Exigence | Priorité |
|---|---|---|
| `RF-M06-01` | **Moteur de règles 100 % paramétrable et versionné** : aucun taux, plafond, plancher, seuil de tranche ni pourcentage de majoration n'est codé en dur. Tous les paramètres sociaux, fiscaux et conventionnels sont stockés en base avec dates d'effet (`effective_from`, `effective_to`), motif réglementaire (référence de loi/décret/arrêté) et historique complet. | P0 |
| `RF-M06-02` | **Gestion multi-devises (CDF, USD, EUR)** : salaire contractuel en devise choisie, gestion des taux de change (taux officiel BCC et taux interne de paie si distinct, dans le respect de la réglementation), figeage du taux sur le cycle de paie, conversion automatique des assiettes fiscales et sociales en CDF et édition des montants en devise de contrat et en CDF. | P0 |
| `RF-M06-03` | **Catalogue de rubriques de paie extensible** : gains soumis, gains partiellement exonérés avec plafond automatique (logement, transport par ville/catégorie, allocations familiales légales vs extralégales), gains non imposables (remboursements justifiés, soins médicaux), avantages en nature, retenues sociales, retenues fiscales, retenues personnelles et charges patronales. | P0 |
| `RF-M06-04` | **Cotisations sociales RDC paramétrables** : calcul automatique de la CNSS (quote-part ouvrière et quote-part patronale ventilée par branche : pensions, risques professionnels, prestations aux familles), de l'INPP (taux patronal déterminé selon la tranche d'effectif paramétrée ou le statut de l'entreprise), de l'ONEM et des cotisations conventionnelles/syndicales/mutuelles. | P0 |
| `RF-M06-05` | **Fiscalité salariale RDC paramétrable** : calcul automatique de l'IPR par barème progressif, application des réductions pour personnes à charge, du plafonnement global et de l'impôt minimum paramétrés ; prise en charge des régimes spécifiques (journaliers/occasionnels, imposition distincte des indemnités de fin de carrière) et de l'IERE pour le personnel expatrié (régime général et régimes sectoriels dérogatoires paramétrables). | P0 |
| `RF-M06-06` | **Contrôle SMIG et grille salariale** : alerte (ou blocage configurable) lorsqu'un salaire de base est inférieur au SMIG paramétré pour la catégorie/échelon de l'agent au prorata du temps de travail. | P0 |
| `RF-M06-07` | **Acomptes, avances, prêts et saisies-arrêts** : gestion des acomptes de quinzaine, avances exceptionnelles, prêts internes avec tableau d'amortissement automatique (suspension/report possible d'une échéance), oppositions/saisies-arrêts et contrôle automatique de la quotité cessible et saisissable légale. | P0 |
| `RF-M06-08` | **Cycle de paie contrôlé et simulation** : exécution illimitée de simulations en brouillon, calcul individuel ou global (par entreprise ou par établissement), rapport automatique de contrôle et d'écarts par rapport au mois M-1, circuit d'approbation (Préparation Paie → Contrôle RH → Validation DAF/DG), clôture irréversible et gestion des rappels/régularisations sur mois suivants. | P0 |
| `RF-M06-09` | **Décompte final (solde de tout compte)** : assistant dédié de fin de contrat calculant le salaire des jours prestés, l'indemnité compensatrice de préavis (ou retenue), l'indemnité compensatrice de congés non pris, l'indemnité de licenciement/fin de carrière selon ancienneté et motif, l'apurement des prêts/avances, la fiscalité spécifique et le document de décompte final. | P0 |
| `RF-M06-10` | **Bulletins de paie professionnels et vérifiables** : génération PDF haute qualité conforme aux mentions obligatoires du Code du Travail RDC, code de vérification d'intégrité (empreinte SHA-256), archivage S3 immuable, distribution sécurisée dans le portail agent, envoi chiffré/protégé optionnel et impression groupée par site. | P0 |
| `RF-M06-11` | **Paiements, déclarations et comptabilité** : génération des états récapitulatifs mensuels et annuels pour la DGI (IPR, IERE), la CNSS, l'INPP et l'ONEM (déclaration unique), du livre de paie, des fichiers d'ordres de virement bancaire / Mobile Money paramétrables et du journal d'écritures comptables au format **SYSCOHADA révisé** (avec ventilation analytique par site/projet). | P1 |

---

### Module M07 — Rapports, Statistiques et Portail Agent (ESS)

| ID | Exigence | Priorité |
|---|---|---|
| `RF-M07-01` | **Tableaux de bord opérationnels et directionnels** : indicateurs temps réel de présence par site (présents, absents, retards, terminaux actifs), évolution des effectifs (entrées, sorties, turnover, pyramide des âges/anciennetés, parité H/F, répartition contrats), suivi de la masse salariale (brut, net, charges patronales, impôts, heures sup., évolution M/M-1 et N/N-1). | P0 |
| `RF-M07-02` | **Bibliothèque de rapports et exports** : registre de l'employeur, feuilles de présence journalières/mensuelles par site, état des retards et absences, solde des congés (et provision comptable congés payés), livre de paie, journal des charges, liste des contrats arrivant à échéance — exportables en PDF, Excel (`.xlsx`) et CSV avec journalisation de chaque export. | P0 |
| `RF-M07-03` | **Portail Self-Service Agent (ESS — Web & PWA mobile)** : consultation de son profil, de son badge QR Code, de son planning, de son historique de pointages, de ses soldes de congés ; soumission de demandes de congés, permissions, attestations ou acomptes ; téléchargement de ses bulletins de paie. | P1 |
| `RF-M07-04` | **Génération d'attestations RH** : modèles paramétrables (attestation de service, certificat de travail, ordre de mission, notification de congé) pré-remplis automatiquement et archivés dans le dossier agent. | P1 |

---

### Module M08 — Sécurité, Permissions, Audit, Notifications et API Externe

| ID | Exigence | Priorité |
|---|---|---|
| `RF-M08-01` | **Authentification forte** : connexion par courriel/identifiant + mot de passe robuste (Argon2id), authentification multi-facteurs (MFA TOTP) obligatoire pour les rôles d'administration et de paie, gestion des sessions actives et révocation immédiate, politique de verrouillage anti-force brute. | P0 |
| `RF-M08-02` | **Autorisations granulaires (RBAC + périmètre site)** : rôles prédéfinis et personnalisables combinant des permissions fines par ressource/action (`employees:read`, `payroll:approve`, `biometrics:enroll`, etc.) et un périmètre organisationnel (toute l'entreprise, liste d'établissements ou département). | P0 |
| `RF-M08-03` | **Séparation des tâches (SoD)** : possibilité d'interdire qu'un même utilisateur prépare et approuve un cycle de paie, ou modifie son propre salaire / valide ses propres régularisations de présence. | P0 |
| `RF-M08-04` | **Gouvernance du consentement biométrique** : enregistrement obligatoire du consentement écrit (date, version de notice, preuve scannée, modalités acceptées) avant tout enrôlement biométrique ; procédure de retrait en un clic entraînant la purge immédiate des gabarits en base et l'émission d'ordres de suppression vers tous les terminaux concernés, avec bascule automatique sur QR Code / PIN. | P0 |
| `RF-M08-05` | **Journal d'audit immuable** : enregistrement systématique (acteur, tenant, rôle, IP, user-agent, horodatage UTC, action, entité, valeurs avant/après masquées des secrets, empreinte SHA-256 chaînée) de toute action sensible (connexion, modification RH/contrat/salaire, pointage manuel, modification de règle de paie, clôture, export de données, consultation de bulletin, opération biométrique). | P0 |
| `RF-M08-06` | **Centre de notifications** : notifications in-app et courriel (et connecteur SMS/WhatsApp optionnel en P2) pour validations en attente, fins de contrat/essai, disponibilité des bulletins, échéances déclaratives et terminaux hors ligne. | P1 |
| `RF-M08-07` | **API externe sécurisée et Webhooks** : API REST versionnée (`/api/v1`), documentée OpenAPI 3.1, authentifiée par clés API à portée limitée (scopes) ou OAuth2 Client Credentials, avec quotas par tenant et webhooks signés HMAC-SHA256 pour l'intégration avec ERP (Odoo, Sage, SAP) et outils BI. | P2 |

---

## 3. Exigences non fonctionnelles (RNF)

| ID | Domaine | Exigence mesurable |
|---|---|---|
| `RNF-01` | **Isolation multi-tenant** | Zéro fuite de données inter-entreprises ; vérification systématique par tests automatisés sur 100 % des endpoints et politiques PostgreSQL RLS actives sur toutes les tables métier. |
| `RNF-02` | **Performance API** | Temps de réponse P95 < 300 ms sur les lectures paginées courantes et < 600 ms sur les écritures unitaires sous une charge de 200 utilisateurs simultanés. |
| `RNF-03` | **Performance ingestion biométrique** | Capacité du `device-gateway` à absorber des pics d'embauche (ex. 07h45–08h15) d'au moins 500 pointages/seconde via mise en file asynchrone RabbitMQ sans perte. |
| `RNF-04` | **Performance paie** | Calcul asynchrone complet d'un lot de 1 000 bulletins en < 60 s et génération des 1 000 PDF en < 3 min, avec barre de progression en temps réel. |
| `RNF-05` | **Résilience hors ligne** | Fonctionnement autonome de la PWA Kiosque pendant au moins 72 heures sans Internet (capacité locale ≥ 20 000 pointages chiffrés) avec resynchronisation automatique idempotente. |
| `RNF-06` | **Précision financière** | Utilisation exclusive de types décimaux exacts (`NUMERIC` en SQL, bibliothèque décimale exacte en TypeScript) — interdiction formelle des flottants IEEE 754 (`number` binaire) pour tout calcul monétaire. |
| `RNF-07` | **Disponibilité & PRA** | Disponibilité cible ≥ 99,5 % (V1) puis ≥ 99,9 % (Enterprise) ; sauvegardes PostgreSQL chiffrées quotidiennes + archivage continu WAL (PITR) ; objectif RPO ≤ 15 min, RTO ≤ 2 h. |
| `RNF-08` | **Conservation légale** | Archivage inaltérable des bulletins et livres de paie pendant au moins 10 ans (paramétrable) ; purge immédiate des gabarits biométriques à la cessation du contrat ou au retrait du consentement. |
| `RNF-09` | **Compatibilité terminaux utilisateurs** | Application Web compatible Chrome, Edge, Safari, Firefox récents ; PWA Kiosque optimisée pour tablettes Android 10+ (gamme standard disponible en RDC) et iPadOS 15+. |
| `RNF-10` | **Internationalisation** | Interface intégralement en français dès la V1, architecture i18n prête pour l'anglais (indispensable pour les ONG internationales et sociétés minières). |
| `RNF-11` | **Accessibilité & ergonomie** | Contraste conforme WCAG 2.1 AA, navigation clavier sur les formulaires de saisie intensive, états de chargement/erreur explicites et fonctionnement fluide sur connexion 3G/4G (budget JS initial maîtrisé). |
| `RNF-12` | **Maintenabilité** | Typage TypeScript strict (`strict: true`, zéro `any` non justifié), architecture modulaire à faible couplage, documentation d'API générée automatiquement et couverture de tests conforme à `TEST_STRATEGY.md`. |

---

## 4. Contraintes et hypothèses d'exploitation

1. L'exactitude juridique des barèmes fiscaux et sociaux appliqués par une entreprise cliente suppose leur validation initiale et périodique par le responsable paie ou l'expert-comptable de ladite entreprise.
2. L'intégration réelle d'un modèle de pointeuse biométrique nécessite impérativement la mise à disposition physique de cet appareil (ou d'un banc d'essai équivalent), de sa documentation/SDK officiel et d'une connectivité réseau de test avant toute certification commerciale.
3. Le pointage par reconnaissance faciale repose sur des terminaux matériels dotés de capteurs anti-fraude ; la caméra standard d'une tablette PWA est réservée au scan de QR Code (et, en option, à une photo de contrôle horodatée, jamais qualifiée de reconnaissance faciale biométrique certifiée).
