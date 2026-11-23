# RÈGLES DE PAIE PARAMÉTRABLES (RDC) — NEXUS RH

## 1. Avertissement méthodologique et règle d'architecture

1. **Zéro taux, seuil ou plafond codé en dur** : conformément aux règles strictes de NEXUS RH, **aucun** pourcentage de cotisation, **aucune** tranche fiscale, **aucun** montant de SMIG, **aucun** plafond d'exonération ni **aucun** taux de majoration d'heures supplémentaires ne sera jamais écrit en dur dans le code source TypeScript ou SQL applicatif.
2. **Statut des valeurs mentionnées dans ce document** : les mécanismes et valeurs cités ci-dessous décrivent le cadre réglementaire congolais **à titre de référence fonctionnelle pour dimensionner le moteur de paramétrage**. Avant toute utilisation en production réelle, le jeu de paramètres initial (`PayrollRuleSet`) de chaque entreprise cliente doit être **vérifié, daté et validé** par le responsable paie, le conseiller fiscal ou l'expert-comptable agréé (ONEC) de l'entreprise, sur la base de la Loi de Finances, des décrets SMIG, des arrêtés ministériels et de la convention collective en vigueur à la date de paie.
3. **Historisation et reproductibilité parfaite** : chaque règle porte une période d'effet (`effective_from` → `effective_to`) et une référence légale. Lors du calcul d'un cycle de paie, l'intégralité du jeu de règles et des taux de change utilisés est **figée dans un instantané immuable** (`frozen_rule_set_snapshot`, `frozen_exchange_rates`), garantissant qu'un changement ultérieur de la loi ne modifie jamais les paies passées et qu'un rappel rétroactif utilise les règles de la période concernée.

---

## 2. Cadre juridique et institutionnel couvert en RDC

| Domaine | Institutions & textes de référence à supporter par le moteur |
|---|---|
| **Droit du travail & rémunération** | Code du Travail (Loi n° 015/2002 modifiée et complétée par la Loi n° 16/010 du 15 juillet 2016), décrets fixant le SMIG et la tension salariale, arrêtés ministériels sur la durée du travail, les heures supplémentaires, le travail de nuit, les congés et le bulletin de paie, conventions collectives sectorielles et d'entreprise. |
| **Sécurité sociale** | **CNSS** (Caisse Nationale de Sécurité Sociale) — Loi n° 16/009 du 15 juillet 2016 relative au régime général de la sécurité sociale et décrets d'application fixant les taux et assiettes des branches Pensions, Risques Professionnels et Prestations aux Familles. |
| **Formation professionnelle** | **INPP** (Institut National de Préparation Professionnelle) — cotisation patronale dont le taux dépend de la tranche d'effectif ou du statut juridique de l'employeur. |
| **Emploi** | **ONEM** (Office National de l'Emploi) — contribution patronale sur les rémunérations. |
| **Fiscalité salariale** | **DGI** (Direction Générale des Impôts) — Ordonnance-Loi n° 69/009 et Lois de Finances annuelles : **IPR** (Impôt Professionnel sur les Rémunérations), **IERE** (Impôt Exceptionnel sur les Rémunérations du Personnel Expatrié), régimes spécifiques (occasionnels, indemnités de fin de carrière, régimes sectoriels tels que le Code Minier, exonérations conventionnelles/diplomatiques justifiées). |
| **Déclaration & paiement** | Déclaration unique mensuelle des impôts et cotisations sociales (DGI / CNSS / INPP / ONEM — échéance paramétrable, par référence le 15 du mois suivant) et états récapitulatifs annuels. |
| **Monnaie & comptabilité** | Taux de change de la **Banque Centrale du Congo (BCC)** (CDF / USD / EUR) et comptabilisation selon l'Acte uniforme **OHADA — SYSCOHADA révisé**. |

---

## 3. Pipeline déterministe de calcul d'un bulletin (10 étapes)

Le module `packages/payroll-engine` exécute un pipeline séquentiel, pur (sans accès réseau ni base de données), entièrement en arithmétique décimale exacte (`decimal.js`) :

```text
[Entrées] Contrat + Profil Agent + Variables GTA validées + Éléments variables/récurrents
          + Prêts/Avances + PayrollRuleSet (versionné) + Taux de change figés
    │
    ▼
Étape 1 — Détermination du prorata de présence & du salaire de base
          (jours ouvrés de référence, entrée/sortie en cours de mois, absences déductibles,
           congés payés / maternité / maladie selon pay_ratio paramétré, contrôle SMIG)
    │
    ▼
Étape 2 — Calcul des éléments liés au temps (GTA)
          (heures supplémentaires validées ventilées par tranche paramétrée,
           majorations nuit / repos / jours fériés, retenues retards selon règlement)
    │
    ▼
Étape 3 — Calcul des primes, indemnités et avantages en nature
          (prime d'ancienneté, primes de fonction/rendement/risque/caisse/panier,
           logement, transport lié aux jours prestés, allocations familiales, soins médicaux)
    │
    ▼
Étape 4 — Ventilation fiscale et sociale & application des plafonds d'exonération
          (séparation automatique entre fraction exonérée et fraction excédentaire réintégrée
           dans les assiettes CNSS / INPP / ONEM / IPR / IERE ; conversion en CDF au taux figé)
    │
    ▼
Étape 5 — Calcul des cotisations sociales salariales (ex. CNSS QPO)
          (application plancher/plafond éventuel et taux paramétré par branche)
    │
    ▼
Étape 6 — Calcul de l'assiette nette imposable et des impôts salariaux (IPR)
          (Brut imposable CDF − cotisations salariales déductibles → barème progressif
           ou taux spécifique → réduction personnes à charge → plafonnement global
           → contrôle de l'impôt minimum paramétré)
    │
    ▼
Étape 7 — Calcul des charges et impôts patronaux
          (CNSS QPP par branche, INPP selon tranche d'effectif, ONEM,
           IERE si agent expatrié selon régime du contrat/secteur, mutuelle patronale)
    │
    ▼
Étape 8 — Calcul des retenues personnelles & contrôle de la quotité saisissable
          (cotisation syndicale, acompte quinzaine, avances, échéances de prêts,
           saisies-arrêts / pensions alimentaires dans la limite légale paramétrée)
    │
    ▼
Étape 9 — Calcul du Net à payer, arrondis monétaires et ventilation de paiement
          (Net CDF, contre-valeur devise de contrat, split éventuel banque/Mobile Money/caisse,
           gestion éventuelle du report d'arrondi de coupure)
    │
    ▼
Étape 10 — Génération de la trace explicative (CalculationTrace) & contrôles de cohérence
           (vérification Net >= 0, écart vs M-1, alertes SMIG/plafonds, hash SHA-256)
```

---

## 4. Spécification des paramètres métier RDC (tous configurables en base)

### 4.1 Temps de travail, absences, heures supplémentaires et ancienneté

| Paramètre configurable | Clé de configuration type | Comportement du moteur & référence indicative à valider |
|---|---|---|
| Durée légale hebdomadaire / mensuelle | `standard_weekly_hours`, `standard_monthly_days`, `standard_monthly_hours` | Paramétrable par horaire/convention (réf. usuelle RDC : 45 h/semaine, 26 jours ouvrables/mois, base horaire mensuelle paramétrable). |
| Taux horaire et journalier de base | `daily_rate_formula`, `hourly_rate_formula` | Calculé à partir du salaire de base et du diviseur paramétré. |
| Tranches d'heures supplémentaires | Table `overtime_rate_rules` | Nombre illimité de tranches paramétrables (réf. indicative : majoration tranche 1 pour les 6 premières heures au-delà de la durée légale, tranche 2 pour les heures suivantes, tranche repos hebdomadaire / jour férié). |
| Majoration travail de nuit | `night_window_start`, `night_window_end`, `night_multiplier` | Plage horaire et taux de majoration paramétrables selon arrêté et convention collective. |
| Prime d'ancienneté | Rubrique `SENIORITY_BONUS` | Taux annuel par année complète de service chez le même employeur, base de calcul et plafond éventuel entièrement paramétrables. |
| Congé annuel & maternité | Table `leave_types` | Acquisition mensuelle, bonus d'ancienneté par tranche d'années, taux de maintien salarial (ex. congé annuel vs indemnité de maternité) et règles d'imposition/cotisation paramétrables. |
| SMIG & tension salariale | Table `smig_schedules` & `job_categories` | Montant journalier/mensuel en CDF par catégorie et échelon, versionné à chaque nouveau décret ou palier d'application. |

### 4.2 Indemnités légales et plafonds d'exonération (`payroll_exemption_caps`)

Le moteur sépare automatiquement pour chaque indemnité la **part exonérée** de la **part excédentaire imposable/cotisable** :

1. **Indemnité de logement** : plafond paramétrable en pourcentage de la rémunération de base/brute définie par la règle (réf. usuelle : plafond légal de 30 %) ; tout excédent est automatiquement basculé dans l'assiette imposable avec ligne explicative dans la trace de calcul.
2. **Indemnité de transport** : plafond journalier paramétrable par **zone/ville** (`KINSHASA`, `LUBUMBASHI`, `GOMA`, `KOLWEZI`, `MATADI`, etc.) et par **catégorie d'agent** (nombre de courses quotidiennes × tarif officiel paramétré de la course de bus ou de taxi), multiplié par le nombre de jours ouvrables effectivement prestés issu du module GTA.
3. **Allocations familiales** : montant légal par enfant éligible (sur justificatif valide) exonéré ; toute allocation familiale **extralégale** versée au-delà du barème légal est automatiquement traitée comme complément imposable selon la règle configurée.
4. **Soins médicaux et frais professionnels** : paramétrables comme non imposables lorsqu'ils correspondent à une prise en charge légale ou à des remboursements sur justificatifs (hors allocations forfaitaires assimilées à un complément de salaire).
5. **Avantages en nature** : règles d'évaluation et d'intégration dans les assiettes paramétrables par nature d'avantage.

### 4.3 Cotisations sociales (`payroll_contribution_rules`)

Toutes les lignes sont configurées en base par organisme et par branche (avec possibilité d'ajouter, désactiver ou re-dater une branche sans toucher au code) :

| Organisme | Branches / règles supportées par le modèle | Paramètres stockés en base (valeurs de référence à valider) |
|---|---|---|
| **CNSS** | Quote-part ouvrière (`PENSION_EMP`) + Quote-part patronale ventilée (`PENSION_ER`, `OCCUPATIONAL_RISK_ER`, `FAMILY_BENEFIT_ER`) | Taux par branche *(réf. indicative Décret 18/041 : 5 % salarié ; 13 % employeur dont 5 % pensions, 1,5 % risques professionnels, 6,5 % prestations familiales)*, plancher éventuel (SMIG), plafond éventuel (`NULL` si déplafonné), indicateur `deductible_from_ipr = true` pour la part salariale. |
| **INPP** | Cotisation patronale par tranche d'effectif ou statut juridique | Tranches d'effectif (`min`/`max`) et taux associés *(réf. indicative : 1–50 agents, 51–300 agents, > 300 agents, et règle spécifique entreprises publiques)*, assiette en CDF. |
| **ONEM** | Contribution patronale | Taux patronal *(réf. indicative : 0,2 %)*, assiette en CDF. |
| **Conventionnelles** | Syndicat (*check-off*), mutuelle de santé, fonds social, assurance complémentaire | Taux ou forfait, part salariale/patronale, plafond et déductibilité paramétrables par entreprise. |

### 4.4 Fiscalité sur les rémunérations (`payroll_tax_regimes` & `payroll_tax_brackets`)

1. **IPR — Régime général (`IPR_STANDARD`)** :
   - **Assiette** : somme des rubriques marquées `included_in_ipr_base = true` (converties en CDF) moins les cotisations salariales marquées `deductible_from_ipr = true` (CNSS part ouvrière).
   - **Barème progressif** : nombre libre de tranches ordonnées `(min_amount, max_amount, rate)` en CDF (annuelles ramenées au mois ou directement mensuelles, selon `periodicity`), mises à jour par simple création d'une nouvelle version lors d'une nouvelle Loi de Finances.
   - **Réduction pour personnes à charge** : taux par personne à charge (`dependent_reduction_rate`), nombre maximal de personnes prises en compte (`max_dependents_count`) et seuil/tranche maximale d'applicabilité (`dependent_reduction_max_bracket_order`) intégralement paramétrés *(réf. indicative : 2 % par personne jusqu'à 9 personnes sous réserve des seuils légaux)*.
   - **Plafonnement global** : application automatique de `max_effective_rate` *(réf. indicative : l'IPR ne peut excéder 30 % du revenu net imposable)*.
   - **Impôt minimum** : application automatique de `minimum_monthly_tax` en CDF selon la Loi de Finances en vigueur.
2. **IPR — Régimes particuliers paramétrables** :
   - Personnel occasionnel / journalier (taux proportionnel configurable).
   - Indemnités de fin de carrière / décompte final (taux proportionnel distinct configurable sur les éléments éligibles, séparé de la rémunération ordinaire du dernier mois).
   - Exonérations spécifiques (personnel diplomatique ou accords de siège dûment référencés avec numéro d'accord obligatoire dans l'audit).
3. **IERE — Personnel expatrié (`IERE_GENERAL`, régimes sectoriels)** :
   - Déclenché lorsque l'agent porte `is_expatriate = true` et un régime IERE actif sur son contrat.
   - Charge **exclusivement patronale** (n'ampute pas le net du salarié, mais apparaît dans les charges employeur, les déclarations DGI et les écritures comptables).
   - Taux et assiette paramétrables par régime (régime de droit commun et régimes sectoriels dérogatoires tels que le secteur minier, avec référence légale obligatoire).

---

## 5. Gestion multi-devises (CDF / USD / EUR)

1. Un contrat peut être libellé en `CDF`, `USD` ou `EUR` (et une même entreprise peut employer simultanément des agents en CDF et des agents en USD).
2. Toutes les assiettes et retenues légales congolaises (SMIG, CNSS, INPP, ONEM, IPR, IERE) sont calculées et arrondies en **Francs Congolais (CDF)** à partir du taux de change de référence (`BCC_OFFICIAL` ou taux légalement applicable paramétré) figé sur le lot de paie.
3. Le bulletin de paie affiche clairement : la devise de contrat, le **taux de change exact appliqué** (avec sa date et sa source), le détail complet en CDF et la contre-valeur dans la devise de paiement, ainsi que la répartition éventuelle en cas de paiement mixte (*split* CDF + USD).
4. En comptabilité SYSCOHADA, tout écart éventuel entre taux de provision et taux de règlement bancaire peut être isolé sur un compte d'écart de change paramétré.

---

## 6. Acomptes, prêts, saisies-arrêts et décompte final

1. **Contrôle de la quotité cessible et saisissable** : lors de l'imputation des prêts et oppositions/saisies-arrêts, le moteur vérifie automatiquement les plafonds paramétrés dans `garnishment_rules` (conformément à l'article 114 du Code du Travail, avec distinction entre créances ordinaires et pensions alimentaires). Si les échéances dépassent la quotité autorisée, le moteur plafonne ou alerte le gestionnaire de paie et reporte le reliquat de manière tracée.
2. **Décompte final (solde de tout compte)** :
   - Calcul automatique selon le motif de rupture (`RESIGNATION`, `DISMISSAL_WITH_NOTICE`, `GROSS_MISCONDUCT`, `END_OF_CDD`, `MUTUAL_AGREEMENT`, `RETIREMENT`, `DEATH`, `ECONOMIC_DISMISSAL`) :
     - salaire des jours prestés et heures supplémentaires non encore payées ;
     - indemnité compensatrice de préavis (durée de base par catégorie + jours additionnels par année d'ancienneté paramétrés) ;
     - indemnité compensatrice de congés payés non pris (issue du solde réel `leave_balances`) ;
     - indemnité de fin de carrière / licenciement / rapatriement éventuel selon règles paramétrées ;
     - compensation réglementée des avances/prêts restants ;
     - séparation de l'imposition ordinaire et de l'imposition spécifique des indemnités de rupture.

---

## 7. Mentions du bulletin de paie et livrables déclaratoires

### 7.1 Mentions du bulletin de paie PDF
- Identification complète de l'employeur (raison sociale, adresse, établissement, RCCM, Id. Nat., NIF, n° CNSS, n° INPP, n° ONEM).
- Identification complète de l'agent (matricule, nom, post-nom, prénom, fonction, département, catégorie/échelon, date d'embauche/ancienneté, situation familiale, nombre de personnes à charge, n° CNSS individuel, type de contrat).
- Période de paie, date de paiement, mode de paiement (compte masqué), devise et taux de change appliqué.
- Bloc présence : jours ouvrables, jours prestés, congés payés, absences justifiées/injustifiées, heures supplémentaires par taux, heures de nuit.
- Tableau détaillé des rubriques : code, libellé, base, nombre/taux, gains salarié, retenues salarié, charges patronales (affichage configurable).
- Récapitulatif : Brut total, Brut cotisable CNSS, Brut imposable IPR, Total cotisations salariales, IPR, Autres retenues, **Net à payer** (en CDF et en devise de contrat), cumul annuel imposable et solde de congés acquis/pris/restant.
- Empreinte cryptographique de vérification (`SHA-256`) + mentions de conservation légale.

### 7.2 États post-paie générés
1. **Livre de paie** mensuel et annuel (global, par établissement, par département, par centre de coût/projet).
2. **États de préparation à la déclaration unique** : bordereaux détaillés nominatifs et synthétiques **DGI (IPR & IERE)**, **CNSS** (par branche), **INPP** et **ONEM** (PDF, Excel, CSV structuré paramétrable).
3. **Ordres de paiement** : fichiers de virement par banque (séparés par devise CDF / USD), listes de paiement Mobile Money et bordereaux d'émargement de caisse.
4. **Journal comptable SYSCOHADA révisé** : écritures équilibrées (comptes 66 charges de personnel, 42 personnel, 43 organismes sociaux CNSS/INPP/ONEM, 44 État IPR/IERE, 52/57 trésorerie) entièrement paramétrables par entreprise, prêtes à importer dans Sage, Odoo ou tout logiciel comptable OHADA.
