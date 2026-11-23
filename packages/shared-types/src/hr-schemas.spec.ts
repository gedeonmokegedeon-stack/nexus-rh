import { describe, expect, it } from 'vitest';
import {
  addCalendarMonthsIso,
  computeCompletedYears,
  createContractSchema,
  createDependentSchema,
  createEmployeeSchema,
  isoDateSchema,
  issueBadgeSchema,
  recordEmployeeConsentSchema,
  updateEmployeeSchema,
  uploadEmployeeDocumentSchema,
} from './hr-schemas';

const SITE_ID = '01900000-0000-7000-8000-000000000001';
const DOC_ID = '01900000-0000-7000-8000-000000000002';

describe('@nexus-rh/shared-types — Vague 1 : F-04 (dates ISO) & G-01 (règles techniques RH RDC)', () => {
  describe('F-04 : isoDateSchema (calendrier grégorien strict & années bissextiles)', () => {
    it('accepte les dates calendaires valides, les fins de mois réelles et les années bissextiles', () => {
      const validDates = [
        '1900-01-01',
        '1960-06-30',
        '1995-04-30',
        '2000-02-29', // Siècle divisible par 400 -> bissextile
        '2024-02-29', // Divisible par 4 -> bissextile
        '2026-01-31',
        '2026-02-28',
        '2026-03-31',
        '2026-04-30',
        '2026-05-31',
        '2026-06-30',
        '2026-07-31',
        '2026-08-31',
        '2026-09-30',
        '2026-10-31',
        '2026-11-17',
        '2026-12-31',
        '2028-02-29',
        '2100-12-31',
      ];

      for (const d of validDates) {
        const res = isoDateSchema.safeParse(d);
        expect(res.success, `Attendu valide : ${d}`).toBe(true);
      }

      // Préserve le .trim() existant pour éviter toute régression sur les formulaires
      const trimmed = isoDateSchema.safeParse('  2026-11-17  ');
      expect(trimmed.success).toBe(true);
      if (trimmed.success) {
        expect(trimmed.data).toBe('2026-11-17');
      }
    });

    it('rejette catégoriquement les dates calendaires impossibles, les faux 29 février et les formats déviants', () => {
      const invalidDates = [
        '2026-02-29', // 2026 non bissextile (ancien report silencieux vers 2026-03-01)
        '2026-02-30',
        '2026-02-31', // Ancien report silencieux vers 2026-03-03
        '2024-02-30', // Même en année bissextile, 30 février n'existe pas
        '1900-02-29', // Siècle non divisible par 400 -> NON bissextile
        '2100-02-29', // Siècle non divisible par 400 -> NON bissextile
        '2026-04-31', // Avril = 30 jours
        '2026-06-31', // Juin = 30 jours
        '2026-09-31', // Septembre = 30 jours
        '2026-11-31', // Novembre = 30 jours
        '2026-00-15',
        '2026-13-01',
        '2026-01-00',
        '2026-01-32',
        '0000-01-01',
        '1899-12-31',
        '2101-01-01',
        '2026-2-05',
        '2026-02-5',
        '17-11-2026',
        '2026/11/17',
        '2026-11-17T00:00:00Z',
        '',
      ];

      for (const d of invalidDates) {
        const res = isoDateSchema.safeParse(d);
        expect(res.success, `Attendu rejeté : ${d}`).toBe(false);
      }

      // Propagation vérifiée sur les schémas RH consommateurs
      expect(issueBadgeSchema.safeParse({ pin: '482917', expiresAt: '2026-02-31' }).success).toBe(
        false,
      );
      expect(
        createDependentSchema.safeParse({
          fullName: 'Mbuyi Junior',
          relationship: 'CHILD_LEGITIMATE',
          birthDate: '2023-02-29',
        }).success,
      ).toBe(false);
      expect(
        updateEmployeeSchema.safeParse({
          status: 'TERMINATED',
          terminationDate: '2026-04-31',
          terminationReason: 'Fin de service',
        }).success,
      ).toBe(false);
    });
  });

  describe('G-01 : Âge révolu exact, cohérence période d’essai, calculs calendaires, expatriés & preuve biométrique', () => {
    it('calcule exactement l’âge révolu (mois et jour inclus, y compris naissance un 29 février)', () => {
      // Ancien bug : 2026 - 2010 = 16 acceptait un mineur de 15 ans et 2 jours
      expect(computeCompletedYears('2010-12-31', '2026-01-02')).toBe(15);
      expect(computeCompletedYears('2010-11-18', '2026-11-17')).toBe(15);
      expect(computeCompletedYears('2010-11-17', '2026-11-17')).toBe(16);
      // Naissance le 29 février
      expect(computeCompletedYears('2008-02-29', '2024-02-28')).toBe(15);
      expect(computeCompletedYears('2008-02-29', '2024-02-29')).toBe(16);
      expect(computeCompletedYears('2084-02-29', '2100-02-28')).toBe(15);
      expect(computeCompletedYears('2084-02-29', '2100-03-01')).toBe(16);

      const baseEmp = {
        primarySiteId: SITE_ID,
        lastName: 'KABILA',
        firstName: 'Jean',
        gender: 'M' as const,
      };

      expect(
        createEmployeeSchema.safeParse({
          ...baseEmp,
          birthDate: '2010-12-31',
          hireDate: '2026-01-02',
        }).success,
      ).toBe(false);

      expect(
        createEmployeeSchema.safeParse({
          ...baseEmp,
          birthDate: '2010-11-18',
          hireDate: '2026-11-17',
        }).success,
      ).toBe(false);

      expect(
        createEmployeeSchema.safeParse({
          ...baseEmp,
          birthDate: '2010-11-17',
          hireDate: '2026-11-17',
        }).success,
      ).toBe(true);
    });

    it('calcule exactement les échéances en mois calendaires (CDD 24 mois bissextiles et non bissextiles)', () => {
      // Deux années non bissextiles : 24 mois = 730 jours (2027-01-02 dépasse 24 mois à 731 jours)
      expect(addCalendarMonthsIso('2025-01-01', 24)).toBe('2027-01-01');
      // Année bissextile incluse : 2024-01-01 + 24 mois = 2026-01-01 (731 jours exacts)
      expect(addCalendarMonthsIso('2024-01-01', 24)).toBe('2026-01-01');
      // Départ un 29 février : plafonné au 28 février de l'année non bissextile cible
      expect(addCalendarMonthsIso('2024-02-29', 24)).toBe('2026-02-28');
      expect(addCalendarMonthsIso('2026-08-31', 6)).toBe('2027-02-28');
    });

    it('rejette une fin de période d’essai postérieure au terme d’un contrat à durée déterminée', () => {
      const baseContract = {
        contractNumber: 'CDD-2026-010',
        contractType: 'CDD' as const,
        siteId: SITE_ID,
        startDate: '2026-11-17',
        endDate: '2027-05-17',
        payCurrency: 'CDF' as const,
        baseSalary: '950000.00',
        hiringPlace: 'Kinshasa',
      };

      expect(
        createContractSchema.safeParse({ ...baseContract, probationEndDate: '2027-06-01' }).success,
      ).toBe(false);
      expect(
        createContractSchema.safeParse({ ...baseContract, probationEndDate: '2027-01-17' }).success,
      ).toBe(true);
    });

    it('gère de manière optionnelle et sans déduction automatique le statut expatrié et l’expiration des titres', () => {
      // Ressortissant étranger sans isExpatriate fourni -> accepté sans supposer true automatiquement
      const foreignUnspecified = createEmployeeSchema.safeParse({
        primarySiteId: SITE_ID,
        lastName: 'DUPONT',
        firstName: 'Claire',
        gender: 'F',
        birthDate: '1988-05-12',
        nationalityCode: 'BE',
        hireDate: '2026-11-17',
        identityDocType: 'PERMIS_TRAVAIL_ETRANGER',
        identityDocNumber: 'PTE-RDC-2026-8841',
        identityDocExpiresAt: '2028-11-16',
      });
      expect(foreignUnspecified.success).toBe(true);
      if (foreignUnspecified.success) {
        expect(foreignUnspecified.data.isExpatriate).toBeUndefined();
        expect(foreignUnspecified.data.identityDocExpiresAt).toBe('2028-11-16');
      }

      // Date d'expiration fournie sans type de pièce -> rejeté
      expect(
        createEmployeeSchema.safeParse({
          primarySiteId: SITE_ID,
          lastName: 'DUPONT',
          firstName: 'Claire',
          gender: 'F',
          birthDate: '1988-05-12',
          hireDate: '2026-11-17',
          identityDocExpiresAt: '2028-11-16',
        }).success,
      ).toBe(false);

      // Document avec retentionUntil antérieure à expiresAt -> rejeté
      expect(
        uploadEmployeeDocumentSchema.safeParse({
          category: 'ONEM_VISA',
          title: 'Visa ONEM',
          originalFilename: 'visa.pdf',
          mimeType: 'application/pdf',
          contentBase64: 'JVBERi0xLjQK',
          expiresAt: '2028-12-31',
          retentionUntil: '2027-12-31',
        }).success,
      ).toBe(false);
    });

    it('exige signedDocumentId pour tout consentement biométrique GRANTED (local ou central) sans altérer les refus ni les autres consentements', () => {
      const base = {
        policyVersion: 'RDC-2026.1',
        collectionMethod: 'HR_ATTESTED_PAPER' as const,
        noticeSummary: 'Notice complète d’information remise à l’agent avec alternative QR+PIN.',
        alternativeQrPinOffered: true as const,
      };

      // BIOMETRIC_DEVICE_ONLY + GRANTED sans signedDocumentId -> rejeté (SECURITY_POLICY.md § 3.3 #1)
      expect(
        recordEmployeeConsentSchema.safeParse({
          ...base,
          consentType: 'BIOMETRIC_DEVICE_ONLY',
          decision: 'GRANTED',
          signedDocumentId: null,
        }).success,
      ).toBe(false);

      // BIOMETRIC_DEVICE_ONLY + GRANTED avec signedDocumentId -> accepté
      expect(
        recordEmployeeConsentSchema.safeParse({
          ...base,
          consentType: 'BIOMETRIC_DEVICE_ONLY',
          decision: 'GRANTED',
          signedDocumentId: DOC_ID,
        }).success,
      ).toBe(true);

      // Refus libre de biométrie sans document signé -> toujours accepté sans entrave
      expect(
        recordEmployeeConsentSchema.safeParse({
          ...base,
          consentType: 'BIOMETRIC_DEVICE_ONLY',
          decision: 'REFUSED',
          signedDocumentId: null,
        }).success,
      ).toBe(true);

      // Consentement non biométrique -> politique existante préservée
      expect(
        recordEmployeeConsentSchema.safeParse({
          ...base,
          consentType: 'ELECTRONIC_PAYSLIP',
          decision: 'GRANTED',
          signedDocumentId: null,
        }).success,
      ).toBe(true);
    });
  });
});
