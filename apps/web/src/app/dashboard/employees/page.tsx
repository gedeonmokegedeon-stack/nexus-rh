'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Briefcase,
  CheckCircle2,
  ChevronRight,
  IdCard,
  Lock,
  Plus,
  QrCode,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import {
  type DepartmentOption,
  EMPLOYEE_STATUS_LABELS,
  type EmployeeItem,
  IDENTITY_DOC_LABELS,
  type JobPositionItem,
  MARITAL_STATUS_LABELS,
  MOBILE_MONEY_LABELS,
  PAYMENT_METHOD_LABELS,
  PROFESSIONAL_CATEGORY_LABELS,
  type SiteOption,
  formatEmployeeFullName,
} from '@/lib/hr-types';

const DRC_PROVINCES = [
  'Kinshasa',
  'Kongo-Central',
  'Haut-Katanga',
  'Lualaba',
  'Nord-Kivu',
  'Sud-Kivu',
  'Kasaï-Oriental',
  'Kasaï-Central',
  'Kasaï',
  'Tshopo',
  'Équateur',
  'Ituri',
  'Kwilu',
  'Kwango',
  'Mai-Ndombe',
  'Haut-Lomami',
  'Lomami',
  'Tanganyika',
  'Maniema',
  'Sankuru',
  'Mongala',
  'Nord-Ubangi',
  'Sud-Ubangi',
  'Tshuapa',
  'Bas-Uele',
  'Haut-Uele',
];

interface VerifyQrResponse {
  verified: true;
  method: string;
  verifiedAt: string;
  badgeCode: string;
  site: { id: string; code: string; name: string; timezone: string };
  employee: {
    id: string;
    matricule: string;
    lastName: string;
    postName: string | null;
    firstName: string;
    attendanceMode: string;
  };
}

export default function EmployeesDirectoryPage() {
  const { me, hasPermission } = useAuth();

  const [employees, setEmployees] = useState<EmployeeItem[]>([]);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [positions, setPositions] = useState<JobPositionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Filtres
  const [search, setSearch] = useState('');
  const [filterSiteId, setFilterSiteId] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Panneaux d'action
  const [activeDrawer, setActiveDrawer] = useState<'none' | 'create' | 'positions' | 'verify-qr'>(
    'none',
  );
  const [submitting, setSubmitting] = useState(false);

  // Formulaire création employé RDC
  const [empForm, setEmpForm] = useState({
    primarySiteId: '',
    departmentId: '',
    jobPositionId: '',
    lastName: '',
    postName: '',
    firstName: '',
    gender: 'M' as 'M' | 'F',
    birthDate: '',
    birthPlace: '',
    nationalityCode: 'CD',
    maritalStatus: 'SINGLE',
    hireDate: new Date().toISOString().slice(0, 10),
    workEmail: '',
    phonePrimary: '',
    province: '',
    city: '',
    commune: '',
    physicalAddress: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
    identityDocType: '',
    identityDocNumber: '',
    cnssNumber: '',
    individualTaxId: '',
    paymentMethod: 'BANK_TRANSFER',
    bankName: '',
    bankAccountNumber: '',
    mobileMoneyOperator: '',
    mobileMoneyNumber: '',
  });

  // Formulaire création poste RDC
  const [posForm, setPosForm] = useState({
    code: '',
    title: '',
    departmentId: '',
    professionalCategory: 'TRAVAILLEUR_QUALIFIE',
    echelon: '',
    description: '',
  });

  // Formulaire vérification badge QR + PIN
  const [qrForm, setQrForm] = useState({ siteId: '', qrPayload: '', pin: '' });
  const [qrResult, setQrResult] = useState<VerifyQrResponse | null>(null);

  const canCreateEmp = hasPermission('employees.create');
  const canManageSalary = hasPermission('employees.salary.manage');
  const canManagePositions = hasPermission('organization.departments.manage');
  const canVerifyBadge = hasPermission('employees.badges.verify');

  const loadReferenceData = useCallback(async () => {
    if (!me?.activeTenant) return;
    const [sitesRes, deptsRes, posRes] = await Promise.all([
      hasPermission('organization.sites.read')
        ? api.get<{ sites: SiteOption[] }>('/sites').catch(() => ({ sites: [] }))
        : Promise.resolve({ sites: [] }),
      hasPermission('organization.departments.read')
        ? api.get<{ departments: DepartmentOption[] }>('/departments').catch(() => ({
            departments: [],
          }))
        : Promise.resolve({ departments: [] }),
      api.get<{ jobPositions: JobPositionItem[] }>('/job-positions').catch(() => ({
        jobPositions: [],
      })),
    ]);
    setSites(sitesRes.sites);
    setDepartments(deptsRes.departments);
    setPositions(posRes.jobPositions);

    const defaultSite = sitesRes.sites[0]?.id ?? '';
    setEmpForm((prev) => (prev.primarySiteId ? prev : { ...prev, primarySiteId: defaultSite }));
    setQrForm((prev) => (prev.siteId ? prev : { ...prev, siteId: defaultSite }));
  }, [me?.activeTenant, hasPermission]);

  const loadEmployees = useCallback(async () => {
    if (!me?.activeTenant) {
      setEmployees([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set('search', search.trim());
      if (filterSiteId) qs.set('siteId', filterSiteId);
      if (filterStatus) qs.set('status', filterStatus);
      const query = qs.toString();
      const res = await api.get<{ employees: EmployeeItem[] }>(
        `/employees${query ? `?${query}` : ''}`,
      );
      setEmployees(res.employees);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur lors du chargement du répertoire.');
    } finally {
      setLoading(false);
    }
  }, [me?.activeTenant, search, filterSiteId, filterStatus]);

  useEffect(() => {
    void loadReferenceData();
  }, [loadReferenceData]);

  useEffect(() => {
    void loadEmployees();
  }, [loadEmployees]);

  if (!me?.activeTenant) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-slate-200 bg-white p-8 text-center">
        <IdCard className="mx-auto h-8 w-8 text-slate-400" />
        <h1 className="mt-3 text-lg font-semibold text-slate-900">
          Sélectionnez une entreprise active
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Les dossiers employés RDC sont strictement cloisonnés par entreprise (PostgreSQL FORCE
          RLS).
        </p>
      </div>
    );
  }

  const siteById = new Map(sites.map((s) => [s.id, s]));
  const positionById = new Map(positions.map((p) => [p.id, p]));

  async function handleCreateEmployee(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessBanner(null);
    try {
      const payload: Record<string, unknown> = {
        primarySiteId: empForm.primarySiteId,
        departmentId: empForm.departmentId || null,
        jobPositionId: empForm.jobPositionId || null,
        lastName: empForm.lastName.trim(),
        postName: empForm.postName.trim() || null,
        firstName: empForm.firstName.trim(),
        gender: empForm.gender,
        birthDate: empForm.birthDate,
        birthPlace: empForm.birthPlace.trim() || null,
        nationalityCode: empForm.nationalityCode.trim().toUpperCase() || 'CD',
        maritalStatus: empForm.maritalStatus,
        hireDate: empForm.hireDate,
        workEmail: empForm.workEmail.trim() || null,
        phonePrimary: empForm.phonePrimary.trim() || null,
        province: empForm.province || null,
        city: empForm.city.trim() || null,
        commune: empForm.commune.trim() || null,
        physicalAddress: empForm.physicalAddress.trim() || null,
        emergencyContactName: empForm.emergencyContactName.trim() || null,
        emergencyContactPhone: empForm.emergencyContactPhone.trim() || null,
        identityDocType: empForm.identityDocType || null,
        identityDocNumber: empForm.identityDocNumber.trim() || null,
        cnssNumber: empForm.cnssNumber.trim() || null,
        individualTaxId: empForm.individualTaxId.trim() || null,
        paymentMethod: empForm.paymentMethod,
      };
      if (canManageSalary) {
        payload.bankName = empForm.bankName.trim() || null;
        payload.bankAccountNumber = empForm.bankAccountNumber.trim() || null;
        payload.mobileMoneyOperator = empForm.mobileMoneyOperator || null;
        payload.mobileMoneyNumber = empForm.mobileMoneyNumber.trim() || null;
      }

      const res = await api.post<{ employee: EmployeeItem }>('/employees', payload);
      setSuccessBanner(
        `Dossier agent créé avec matricule atomique ${res.employee.matricule} (pointage par défaut : QR + PIN uniquement).`,
      );
      setActiveDrawer('none');
      setEmpForm((prev) => ({
        ...prev,
        lastName: '',
        postName: '',
        firstName: '',
        birthDate: '',
        birthPlace: '',
        workEmail: '',
        phonePrimary: '',
        identityDocType: '',
        identityDocNumber: '',
        cnssNumber: '',
        individualTaxId: '',
        bankName: '',
        bankAccountNumber: '',
        mobileMoneyOperator: '',
        mobileMoneyNumber: '',
      }));
      await loadEmployees();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de la création du dossier employé.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreatePosition(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessBanner(null);
    try {
      const res = await api.post<{ jobPosition: JobPositionItem }>('/job-positions', {
        code: posForm.code.trim().toUpperCase(),
        title: posForm.title.trim(),
        departmentId: posForm.departmentId || null,
        professionalCategory: posForm.professionalCategory,
        echelon: posForm.echelon.trim() || null,
        description: posForm.description.trim() || null,
      });
      setSuccessBanner(`Poste « ${res.jobPosition.title} » (${res.jobPosition.code}) enregistré.`);
      setPosForm({
        code: '',
        title: '',
        departmentId: '',
        professionalCategory: 'TRAVAILLEUR_QUALIFIE',
        echelon: '',
        description: '',
      });
      await loadReferenceData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de la création du poste.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyQrPin(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setQrResult(null);
    try {
      const res = await api.post<VerifyQrResponse>('/badges/verify-qr-pin', {
        siteId: qrForm.siteId,
        qrPayload: qrForm.qrPayload.trim(),
        pin: qrForm.pin.trim(),
      });
      setQrResult(res);
      setQrForm((prev) => ({ ...prev, pin: '' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de la vérification du badge QR/PIN.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* En-tête */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Dossiers Employés RDC
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Matricules atomiques (
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
              {me.activeTenant.matriculePattern ?? '{SITE}-{YYYY}-{SEQ:5}'}
            </code>
            ), PII chiffrées AES-256-GCM, contrats RDC, badges QR+PIN Argon2id, coffre S3 et
            consentements (OL n° 23/010).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canVerifyBadge && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setQrResult(null);
                setActiveDrawer(activeDrawer === 'verify-qr' ? 'none' : 'verify-qr');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <QrCode className="h-4 w-4 text-blue-700" />
              Contrôler un badge QR + PIN
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setActiveDrawer(activeDrawer === 'positions' ? 'none' : 'positions');
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Briefcase className="h-4 w-4 text-slate-600" />
            Postes RDC ({positions.length})
          </button>
          {canCreateEmp && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setActiveDrawer(activeDrawer === 'create' ? 'none' : 'create');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-blue-800"
            >
              <Plus className="h-4 w-4" />
              Nouvel employé
            </button>
          )}
        </div>
      </div>

      {/* Bannières d'état */}
      {error && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-red-600" />
            {error}
          </span>
          <button type="button" onClick={() => setError(null)} className="text-red-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {successBanner && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            {successBanner}
          </span>
          <button type="button" onClick={() => setSuccessBanner(null)} className="text-emerald-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Panneau 1 : Vérification réelle Badge QR + Code PIN Argon2id */}
      {activeDrawer === 'verify-qr' && (
        <section className="rounded-xl border border-blue-200 bg-white p-6 shadow-2xs">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Vérification de badge QR signé + Code PIN (Alternative non-biométrique)
              </h2>
              <p className="text-xs text-slate-500">
                Contrôle cryptographique HMAC-SHA256 + Argon2id (verrouillage automatique après 5
                échecs consécutifs).
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveDrawer('none')}
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleVerifyQrPin} className="mt-4 grid gap-4 md:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-slate-700">Établissement *</label>
              <select
                required
                value={qrForm.siteId}
                onChange={(e) => setQrForm({ ...qrForm, siteId: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">— Choisir —</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name} ({s.timezone})
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700">
                Jeton QR scanné (NXRH1.…) *
              </label>
              <input
                required
                type="text"
                placeholder="NXRH1.…"
                value={qrForm.qrPayload}
                onChange={(e) => setQrForm({ ...qrForm, qrPayload: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Code PIN personnel (6 chiffres) *
              </label>
              <input
                required
                type="password"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                placeholder="••••••"
                value={qrForm.pin}
                onChange={(e) => setQrForm({ ...qrForm, pin: e.target.value.replace(/\D/g, '') })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tracking-widest"
              />
            </div>
            <div className="md:col-span-4 flex justify-end">
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
              >
                {submitting ? 'Vérification cryptographique…' : 'Vérifier l’identité QR + PIN'}
              </button>
            </div>
          </form>

          {qrResult && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-950">
              <p className="font-semibold text-emerald-900">
                Identité vérifiée avec succès ({qrResult.badgeCode}) — {qrResult.site.name} (
                {qrResult.site.timezone})
              </p>
              <p className="mt-1">
                Agent : <strong>{formatEmployeeFullName(qrResult.employee)}</strong> · Matricule{' '}
                <code className="font-mono font-semibold">{qrResult.employee.matricule}</code> ·
                Mode : <code className="font-mono">{qrResult.employee.attendanceMode}</code> ·
                Horodatage : {new Date(qrResult.verifiedAt).toLocaleString('fr-CD')}
              </p>
            </div>
          )}
        </section>
      )}

      {/* Panneau 2 : Catalogue des Postes & Catégories professionnelles RDC */}
      {activeDrawer === 'positions' && (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs space-y-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Postes & Classification professionnelle RDC
              </h2>
              <p className="text-xs text-slate-500">
                Catégories conformes à la classification générale des emplois en RDC.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveDrawer('none')}
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {canManagePositions && (
            <form onSubmit={handleCreatePosition} className="grid gap-3 md:grid-cols-5">
              <input
                required
                placeholder="Code (ex: COMPT-SR)"
                value={posForm.code}
                onChange={(e) => setPosForm({ ...posForm, code: e.target.value })}
                className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs uppercase"
              />
              <input
                required
                placeholder="Intitulé du poste *"
                value={posForm.title}
                onChange={(e) => setPosForm({ ...posForm, title: e.target.value })}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs md:col-span-2"
              />
              <select
                value={posForm.professionalCategory}
                onChange={(e) => setPosForm({ ...posForm, professionalCategory: e.target.value })}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
              >
                {Object.entries(PROFESSIONAL_CATEGORY_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Ajouter le poste
              </button>
            </form>
          )}

          {positions.length === 0 ? (
            <p className="text-xs text-slate-500">Aucun poste configuré dans cette entreprise.</p>
          ) : (
            <div className="divide-y divide-slate-100 text-xs">
              {positions.map((pos) => (
                <div key={pos.id} className="flex items-center justify-between py-2">
                  <div>
                    <span className="font-mono font-semibold text-slate-800">{pos.code}</span>
                    <span className="mx-2 text-slate-300">·</span>
                    <span className="font-medium text-slate-900">{pos.title}</span>
                  </div>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                    {PROFESSIONAL_CATEGORY_LABELS[pos.professionalCategory] ??
                      pos.professionalCategory}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Panneau 3 : Création d'un dossier employé RDC */}
      {activeDrawer === 'create' && canCreateEmp && (
        <section className="rounded-xl border border-blue-200 bg-white p-6 shadow-2xs">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Nouveau dossier individuel d’employé (RDC)
              </h2>
              <p className="text-xs text-slate-500">
                Le matricule est alloué atomiquement à la validation. Les identifiants CNSS, pièce
                d’identité, NIF et coordonnées bancaires/Mobile Money sont chiffrés en AES-256-GCM.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveDrawer('none')}
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleCreateEmployee} className="mt-5 space-y-5">
            {/* Identité civile RDC */}
            <div>
              <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                1. Identité civile RDC & Affectation
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Nom *</label>
                  <input
                    required
                    value={empForm.lastName}
                    onChange={(e) => setEmpForm({ ...empForm, lastName: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Post-nom</label>
                  <input
                    value={empForm.postName}
                    onChange={(e) => setEmpForm({ ...empForm, postName: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Prénom *</label>
                  <input
                    required
                    value={empForm.firstName}
                    onChange={(e) => setEmpForm({ ...empForm, firstName: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Sexe *</label>
                  <select
                    value={empForm.gender}
                    onChange={(e) => setEmpForm({ ...empForm, gender: e.target.value as 'M' | 'F' })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="M">Masculin (M)</option>
                    <option value="F">Féminin (F)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Date de naissance *
                  </label>
                  <input
                    required
                    type="date"
                    value={empForm.birthDate}
                    onChange={(e) => setEmpForm({ ...empForm, birthDate: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Lieu de naissance
                  </label>
                  <input
                    value={empForm.birthPlace}
                    onChange={(e) => setEmpForm({ ...empForm, birthPlace: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">État civil</label>
                  <select
                    value={empForm.maritalStatus}
                    onChange={(e) => setEmpForm({ ...empForm, maritalStatus: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {Object.entries(MARITAL_STATUS_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Date d’engagement *
                  </label>
                  <input
                    required
                    type="date"
                    value={empForm.hireDate}
                    onChange={(e) => setEmpForm({ ...empForm, hireDate: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Établissement principal *
                  </label>
                  <select
                    required
                    value={empForm.primarySiteId}
                    onChange={(e) => setEmpForm({ ...empForm, primarySiteId: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">— Sélectionner —</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code} — {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Département</label>
                  <select
                    value={empForm.departmentId}
                    onChange={(e) => setEmpForm({ ...empForm, departmentId: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">— Aucun —</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code} — {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Poste occupé</label>
                  <select
                    value={empForm.jobPositionId}
                    onChange={(e) => setEmpForm({ ...empForm, jobPositionId: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">— Non assigné —</option>
                    {positions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code} — {p.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Téléphone principal
                  </label>
                  <input
                    placeholder="+243..."
                    value={empForm.phonePrimary}
                    onChange={(e) => setEmpForm({ ...empForm, phonePrimary: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    E-mail professionnel
                  </label>
                  <input
                    type="email"
                    value={empForm.workEmail}
                    onChange={(e) => setEmpForm({ ...empForm, workEmail: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Province (RDC)</label>
                  <select
                    value={empForm.province}
                    onChange={(e) => setEmpForm({ ...empForm, province: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">— Non renseignée —</option>
                    {DRC_PROVINCES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Ville</label>
                  <input
                    value={empForm.city}
                    onChange={(e) => setEmpForm({ ...empForm, city: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Commune</label>
                  <input
                    value={empForm.commune}
                    onChange={(e) => setEmpForm({ ...empForm, commune: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Identifiants légaux chiffrés */}
            <div className="border-t border-slate-100 pt-4">
              <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <Lock className="h-3.5 w-3.5 text-blue-600" />
                2. Identifiants légaux RDC (chiffrés par enveloppe AES-256-GCM)
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Type de pièce</label>
                  <select
                    value={empForm.identityDocType}
                    onChange={(e) => setEmpForm({ ...empForm, identityDocType: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">— Aucune —</option>
                    {Object.entries(IDENTITY_DOC_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">N° de pièce</label>
                  <input
                    value={empForm.identityDocNumber}
                    onChange={(e) => setEmpForm({ ...empForm, identityDocNumber: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    N° immatriculation CNSS
                  </label>
                  <input
                    value={empForm.cnssNumber}
                    onChange={(e) => setEmpForm({ ...empForm, cnssNumber: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    N° Impôt individuel (DGI)
                  </label>
                  <input
                    value={empForm.individualTaxId}
                    onChange={(e) => setEmpForm({ ...empForm, individualTaxId: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Coordonnées de règlement */}
            {canManageSalary && (
              <div className="border-t border-slate-100 pt-4">
                <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <Lock className="h-3.5 w-3.5 text-blue-600" />
                  3. Coordonnées de paiement (Banque / Mobile Money RDC — chiffrées AES-256-GCM)
                </h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700">Mode</label>
                    <select
                      value={empForm.paymentMethod}
                      onChange={(e) => setEmpForm({ ...empForm, paymentMethod: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      {Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">Banque</label>
                    <input
                      placeholder="Ex: Rawbank, EquityBCDC…"
                      value={empForm.bankName}
                      onChange={(e) => setEmpForm({ ...empForm, bankName: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      RIB / N° compte
                    </label>
                    <input
                      value={empForm.bankAccountNumber}
                      onChange={(e) =>
                        setEmpForm({ ...empForm, bankAccountNumber: e.target.value })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Opérateur Mobile Money
                    </label>
                    <select
                      value={empForm.mobileMoneyOperator}
                      onChange={(e) =>
                        setEmpForm({ ...empForm, mobileMoneyOperator: e.target.value })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value="">— Aucun —</option>
                      {Object.entries(MOBILE_MONEY_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      N° Mobile Money
                    </label>
                    <input
                      placeholder="+243..."
                      value={empForm.mobileMoneyNumber}
                      onChange={(e) =>
                        setEmpForm({ ...empForm, mobileMoneyNumber: e.target.value })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
              <button
                type="button"
                onClick={() => setActiveDrawer('none')}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-blue-700 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
              >
                {submitting ? 'Enregistrement sécurisé…' : 'Créer et attribuer le matricule'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Barre de recherche & filtres */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
          <input
            type="search"
            placeholder="Rechercher par matricule, nom, post-nom ou prénom…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-slate-300 py-2 pr-3 pl-9 text-sm focus:border-blue-600 focus:outline-none"
          />
        </div>
        <select
          value={filterSiteId}
          onChange={(e) => setFilterSiteId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
        >
          <option value="">Tous les établissements autorisés</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} — {s.name}
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
        >
          <option value="">Tous les statuts</option>
          {Object.entries(EMPLOYEE_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {/* Tableau du répertoire des employés */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
        {loading ? (
          <div className="p-10 text-center text-sm text-slate-500">
            Chargement sécurisé du répertoire…
          </div>
        ) : employees.length === 0 ? (
          <div className="p-12 text-center">
            <IdCard className="mx-auto h-9 w-9 text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-800">
              Aucun dossier employé enregistré
            </p>
            <p className="mt-1 text-xs text-slate-500">
              NEXUS RH n’injecte aucun employé fictif. Créez un dossier réel pour attribuer un
              matricule atomique.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Matricule</th>
                  <th className="px-4 py-3">Identité (Nom · Post-nom · Prénom)</th>
                  <th className="px-4 py-3">Établissement / Poste</th>
                  <th className="px-4 py-3">CNSS (masqué)</th>
                  <th className="px-4 py-3">Mode pointage</th>
                  <th className="px-4 py-3">Statut</th>
                  <th className="px-4 py-3 text-right">Dossier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {employees.map((emp) => {
                  const site = siteById.get(emp.primarySiteId);
                  const pos = emp.jobPositionId ? positionById.get(emp.jobPositionId) : null;
                  return (
                    <tr key={emp.id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-blue-800">
                        {emp.matricule}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">{formatEmployeeFullName(emp)}</p>
                        <p className="text-xs text-slate-500">
                          Engagé le {emp.hireDate} · {emp.taxDependentsCount} personne(s) à charge
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <p className="font-medium text-slate-800">
                          {site ? `${site.code} — ${site.name}` : 'Établissement'}
                        </p>
                        <p className="text-slate-500">{pos ? pos.title : 'Poste non assigné'}</p>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {emp.cnssNumberMasked ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 font-mono text-[11px] font-medium ${
                            emp.attendanceMode === 'BIOMETRIC_OR_QR_PIN'
                              ? 'bg-blue-50 text-blue-800 ring-1 ring-blue-200'
                              : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {emp.attendanceMode === 'BIOMETRIC_OR_QR_PIN'
                            ? 'Biométrie locale ou QR+PIN'
                            : 'QR + PIN uniquement'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            emp.status === 'ACTIVE'
                              ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
                              : emp.status === 'TERMINATED'
                                ? 'bg-red-50 text-red-800 ring-1 ring-red-200'
                                : 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
                          }`}
                        >
                          {EMPLOYEE_STATUS_LABELS[emp.status] ?? emp.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/dashboard/employees/${emp.id}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                        >
                          Ouvrir <ChevronRight className="h-3.5 w-3.5" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
