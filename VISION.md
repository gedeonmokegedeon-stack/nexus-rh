# VISION PRODUIT — NEXUS RH

## 1. Ambition et déclaration de vision

**NEXUS RH** a pour vocation de devenir la plateforme SaaS de référence en République Démocratique du Congo — puis dans l'ensemble de l'espace OHADA — pour relier de manière fiable, automatisée et légalement conforme **l'identité de l'agent, sa présence réelle sur le terrain et le calcul exact de sa rémunération**.

> **Promesse produit** : *« Du pointage terrain au bulletin de paie conforme, sans ressaisie, sans fraude, quel que soit le site, la devise ou la marque de pointeuse. »*

---

## 2. Constat terrain et problèmes résolus

Les entreprises et organisations opérant en RDC font face à sept difficultés structurelles majeures que les logiciels étrangers généralistes ou les feuilles Excel ne résolvent pas correctement :

1. **Déconnexion entre pointage et paie** : les relevés de présence (registres papier ou exports CSV de pointeuses isolées) sont retraités manuellement sur tableur en fin de mois, engendrant erreurs de calcul, retards de paie, contestations sociales et heures supplémentaires fictives.
2. **Fraude aux présences et agents fictifs** : pointage de complaisance (*buddy punching*), émargements antidatés, photocopie de badges statiques, modifications non tracées des feuilles d'heures.
3. **Parcs de pointeuses hétérogènes et verrouillés** : une même entreprise possède fréquemment des terminaux ZKTeco au siège, des terminaux Hikvision sur un entrepôt et des chantiers temporaires sans pointeuse fixe. Les logiciels fournis par les fabricants sont mono-marque, souvent limités à un poste Windows local et dépourvus de moteur de paie congolais.
4. **Contraintes d'infrastructure (électricité et Internet)** : délestages électriques, liaisons 4G/VSAT/fibre intermittentes, absence d'adresses IP publiques fixes sur les sites distants. Une solution purement dépendante d'une connexion permanente échoue sur le terrain.
5. **Complexité multi-sites et double fuseau horaire en RDC** : une société implantée à la fois à Kinshasa ou Matadi (`UTC+1`) et à Lubumbashi, Kolwezi, Goma ou Kisangani (`UTC+2`) doit consolider ses effectifs et sa paie tout en respectant les horaires locaux de chaque établissement.
6. **Spécificités de la paie congolaise** : contrats et paiements bi-devises (USD / CDF) avec conversion fiscale au taux de la Banque Centrale du Congo (BCC), barème progressif IPR avec plafonnement et réductions familiales, impôt expatrié (IERE), cotisations CNSS ventilées par branche, taux INPP dégressif par effectif, ONEM, plafonds légaux d'exonération du logement et du transport par ville/catégorie, et évolutions régulières via les Lois de Finances et décrets SMIG.
7. **Déficit de gouvernance et de conformité biométrique** : absence de pistes d'audit inaltérables, partage de comptes administrateurs, et collecte d'empreintes/visages sans encadrement conforme au Code du Numérique congolais.

---

## 3. Proposition de valeur distinctive

| Pilier | Valeur concrète pour le client |
|---|---|
| **Multi-marques ouvert & honnête** | Conservation des terminaux compatibles déjà acquis (ZKTeco, Hikvision, Anviz, Suprema) et déploiement immédiat sur tablette (PWA QR Code + PIN) là où il n'y a pas de pointeuse. |
| **Conçu pour la résilience terrain** | Kiosque PWA fonctionnant hors ligne, exploitation de la mémoire interne des terminaux, passerelle locale optionnelle (*Nexus Edge Agent*) et synchronisation sans perte ni doublon dès le retour du réseau. |
| **Paie RDC native et 100 % paramétrable** | Adaptation immédiate à un nouveau barème IPR, un nouveau SMIG, un taux BCC quotidien ou une convention collective d'entreprise, sans attendre une mise à jour logicielle. |
| **Multi-entreprises & multi-sites natif** | Idéal aussi bien pour une PME mono-site, un groupe industriel à 25 sites sur 8 provinces que pour un cabinet comptable ou une société d'intérim gérant plusieurs entreprises clientes. |
| **Traçabilité et confiance** | Chaque minute pointée, chaque régularisation managériale et chaque franc congolais calculé sur le bulletin sont justifiés, horodatés et audités de manière immuable. |
| **Conformité juridique intégrée** | Respect du Code du Travail, du Code du Numérique (protection des données biométriques, consentement, chiffrement, alternative QR/PIN) et du plan comptable SYSCOHADA. |

---

## 4. Segments de marché cibles

### 4.1 Cœur de cible initial (RDC)

1. **PME et ETI structurées (20 à 500 agents)** : commerce, distribution, logistique, hôtellerie-restauration, agences de services, cliniques privées, écoles et universités privées. Besoin : déploiement rapide, kiosque tablette ou 1 à 5 pointeuses ZKTeco/Hikvision, paie fiable clé en main.
2. **Grandes entreprises multi-sites (500 à 10 000+ agents)** : banques et microfinance, télécoms, brasseries, agro-industrie, entreprises minières et sous-traitants miniers (Haut-Katanga, Lualaba), BTP, sociétés de sécurité privée/gardiennage, réseaux hospitaliers. Besoin : shifts complexes 24/7, multi-fuseaux, multi-marques (dont Suprema/Hikvision), séparation des tâches, IERE expatriés, intégration ERP/comptable, SLA élevé.
3. **ONG nationales et internationales, fondations et projets bailleurs** : besoin de transparence absolue des feuilles de temps (*timesheets*), ventilation analytique par projet/bailleur, gestion bi-devise USD/CDF, conformité stricte en matière de protection des données.
4. **Cabinets d'expertise comptable, fiduciaires et sociétés de portage/intérim** : gestion centralisée multi-dossiers de la paie et des déclarations sociales/fiscales pour le compte de dizaines d'entreprises clientes (mode partenaire multi-tenant).

### 4.2 Extension géographique (horizon 18–36 mois)

Grâce à son moteur de paie entièrement piloté par règles en base de données, NEXUS RH pourra s'étendre sans refonte architecturale vers le Congo-Brazzaville, l'Angola, le Rwanda, le Burundi, le Cameroun, la Côte d'Ivoire et le Sénégal par simple ajout de packs réglementaires pays (`country_code`).

---

## 5. Personas utilisateurs

| Persona | Rôle type | Objectifs principaux dans NEXUS RH |
|---|---|---|
| **Éditeur / Super-Admin SaaS** | Équipe d'exploitation NEXUS RH | Provisionner les entreprises clientes, gérer les abonnements, superviser la santé globale de la plateforme et des passerelles biométriques, maintenir les modèles réglementaires de référence sans accéder arbitrairement aux données privées. |
| **Administrateur Entreprise** | DSI / Directeur Administratif et Financier (DAF) | Configurer les établissements, utilisateurs, rôles, politiques de sécurité, devises, signatures et intégrations bancaires/comptables. |
| **Responsable / Gestionnaire RH** | DRH / Chargé du personnel | Gérer les dossiers agents, contrats, avenants, matricules, badges QR, consentements biométriques, horaires, congés, absences et sanctions. |
| **Gestionnaire de Paie** | Chef comptable / Paie | Paramétrer les rubriques, saisir les éléments variables, importer les temps validés, lancer les simulations, contrôler les écarts, soumettre à approbation et générer bulletins, virements et déclarations DGI/CNSS/INPP/ONEM. |
| **Approbateur Financier (DAF / DG)** | Direction générale / financière | Vérifier les tableaux de contrôle et les variations de masse salariale, approuver et clôturer la paie (principe des quatre yeux), consulter les indicateurs stratégiques. |
| **Chef de Site / Manager** | Responsable d'agence, chef de chantier, surveillant chef | Suivre en temps réel les présents/absents/retardataires de son site, planifier les équipes (shifts), valider les demandes de congés, heures supplémentaires et régularisations motivées. |
| **Technicien Parc Biométrique** | Support IT site | Enrôler les terminaux, surveiller leur état de connexion, enrôler les agents ayant donné leur consentement, diagnostiquer les files de synchronisation. |
| **Opérateur Kiosque** | Réceptionniste / Poste de garde | Superviser la tablette PWA de pointage à l'entrée du site sans accès aux données RH ou salariales. |
| **Agent / Employé** | Tout salarié de l'entreprise | Pointer rapidement (empreinte, visage, QR Code ou PIN), consulter ses pointages, télécharger ses bulletins de paie, soumettre ses demandes de congés ou d'acomptes et vérifier son solde. |
| **Auditeur / Expert-Comptable** | Commissaire aux comptes / Cabinet externe | Accès en lecture seule, borné dans le temps, aux journaux de paie, états déclaratoires et pistes d'audit. |

---

## 6. Modèle commercial SaaS envisagé

> *Note : les paliers fonctionnels ci-dessous constituent une proposition structurante soumise à la validation du propriétaire du projet ; les tarifs commerciaux seront également paramétrables en base de données.*

### 6.1 Formules d'abonnement (par entreprise + par agent actif/mois)

| Offre | Cible | Périmètre inclus |
|---|---|---|
| **NEXUS Essentiel** | PME mono-site (jusqu'à 50 agents) | Dossiers RH, contrats, matricules & badges QR, pointage PWA Tablette (QR + PIN), horaires standards, congés, rapports essentiels. |
| **NEXUS Pro** | PME/ETI multi-sites | Tout *Essentiel* + connecteurs pointeuses biométriques standards (ZKTeco / Hikvision), shifts & heures sup., paie complète RDC multi-devises, bulletins PDF, états DGI/CNSS/INPP/ONEM, portail Agent. |
| **NEXUS Enterprise** | Grands comptes, mines, banques, groupes | Tout *Pro* + multi-sites illimités, connecteurs avancés (Anviz, Suprema, Nexus Edge Agent), workflows multi-niveaux, séparation stricte des tâches, IERE & analytique multi-projets, export SYSCOHADA, API & Webhooks, SLA prioritaire, option d'isolation dédiée. |
| **NEXUS Cabinet** | Fiduciaires & cabinets RH | Console multi-entreprises clientes, facturation groupée au volume d'agents gérés, délégation d'accès client/cabinet. |

### 6.2 Revenus complémentaires possibles

- Frais uniques de mise en service (*onboarding*), reprise d'historique, paramétrage de convention collective et formation sur site.
- Homologation, fourniture partenaire (sans exclusivité matérielle) et installation de terminaux biométriques et kits tablettes kiosques.
- Support technique dédié et contrat de maintenance préventive du parc de pointage.

---

## 7. Principes d'expérience utilisateur (UX)

1. **Clarté opérationnelle avant tout** : interfaces épurées, lisibles sur écrans portables 13 pouces comme sur grands moniteurs, hiérarchie visuelle nette, vocabulaire RH et comptable francophone exact (avec préparation à l'anglais).
2. **Rapidité au poste de pointage** : sur tablette PWA, un pointage QR Code ou PIN doit s'exécuter en moins de 1,5 seconde avec retour visuel et sonore immédiat, même sans connexion Internet.
3. **Explicabilité totale** : sur chaque bulletin de paie en brouillon, un clic sur n'importe quel montant (IPR, CNSS, heures sup., retenue absence) affiche la formule exacte, l'assiette, le taux, la règle versionnée et les données sources ayant produit le résultat.
4. **Zéro action destructive silencieuse** : confirmation explicite, motif obligatoire et traçabilité complète sur toute modification de présence, de contrat, de salaire ou de barème.
5. **Sobriété bande passante** : pages légères, pagination serveur, compression systématique et mise en cache intelligente pour rester fluide sur les connexions mobiles en RDC.

---

## 8. Indicateurs clés de succès (KPIs produit)

| Catégorie | Indicateur cible |
|---|---|
| **Adoption & gain de temps** | Réduction d'au moins 70 % du temps de préparation mensuelle de la paie chez les entreprises clientes. |
| **Fiabilité de la paie** | 0 écart de calcul par rapport aux feuilles de contrôle certifiées par un expert-comptable RDC sur l'ensemble des cas de référence. |
| **Fiabilité du pointage** | 0 perte d'événement de pointage en cas de coupure Internet ≤ 72 h (kiosque PWA / Edge Agent) et 0 doublon imputé en paie. |
| **Performance** | Génération d'un cycle de paie de 1 000 agents en moins de 60 secondes (traitement asynchrone) ; réponse API P95 < 300 ms. |
| **Disponibilité SaaS** | Cible de disponibilité mensuelle ≥ 99,5 % au lancement commercial, évoluant vers 99,9 %. |
| **Sécurité & conformité** | 0 fuite inter-tenant ; 100 % des gabarits biométriques associés à un consentement actif tracé et chiffrés au repos. |

---

## 9. Ce que NEXUS RH ne fera pas (garde-fous produit)

- Ne jamais vendre ni présenter un connecteur biométrique simulé ou non testé sur matériel réel comme étant certifié en production.
- Ne jamais effectuer de reconnaissance faciale ou d'empreinte « approximative » non certifiée dans un navigateur web en la présentant comme équivalente à un terminal biométrique dédié.
- Ne jamais se substituer au conseil juridique ou fiscal du client : NEXUS RH fournit un moteur exact, auditable et paramétrable, dont les paramètres sont validés par l'entreprise cliente et son conseil agréé.
- Ne jamais monétiser ni partager les données personnelles, salariales ou biométriques des clients et de leurs agents.
