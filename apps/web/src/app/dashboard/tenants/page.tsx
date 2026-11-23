'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Plus, Power, CheckCircle2 } from 'lucide-react';
import {
  DRC_PROVINCES,
  LEGAL_FORMS,
  SECTOR_CODES,
  SUPPORTED_CURRENCIES,
} from '@nexus-rh/shared-types';
import { api, ApiError, type TenantSummary } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

export default function PlatformTenantsPage() {
  const { me, refreshProfile, switchTenant } = useAuth();
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Formulaire de création d'entreprise
  const [legalName, setLegalName] = useState('');
  const [slug, setSlug] = useState('');
  const [legalForm, setLegalForm] = useState<(typeof LEGAL_FORMS)[number]>('SARL');
  const [sectorCode, setSectorCode] = useState<(typeof SECTOR_CODES)[number]>('GENERAL');
  const [defaultCurrency, setDefaultCurrency] = useState<(typeof SUPPORTED_CURRENCIES)[number]>('CDF');
  const [rccm, setRccm] = useState('');
  const [idNat, setIdNat] = useState('');
  const [taxIdDgi, setTaxIdDgi] = useState('');
  const [cnss, setCnss] = useState('');
  const [inpp, setInpp] = useState('');
  const [onem, setOnem] = useState('');
  const [isDemoTenant, setIsDemoTenant] = useState(false);
  const [hqCode, setHqCode] = useState('KIN-HQ');
  const [hqName, setHqName] = useState('Siège social');
  const [hqProvince, setHqProvince] = useState('Kinshasa');
  const [hqCity, setHqCity] = useState('Kinshasa');
  const [hqTimezone, setHqTimezone] = useState<'Africa/Kinshasa' | 'Africa/Lubumbashi'>(
    'Africa/Kinshasa',
  );

  const loadTenants = useCallback(async () => {
    try {
      const res = await api.get<{ tenants: TenantSummary[] }>('/platform/tenants');
      setTenants(res.tenants);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger les entreprises.');
    }
  }, []);

  useEffect(() => {
    if (me?.user.isPlatformSuperadmin) {
      void loadTenants();
    }
  }, [me, loadTenants]);

  function handleProvinceChange(provinceName: string) {
    setHqProvince(provinceName);
    const info = DRC_PROVINCES.find((p) => p.name === provinceName);
    if (info) {
      setHqTimezone(info.defaultTimezone);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const created = await api.post<{ tenant: TenantSummary }>('/platform/tenants', {
        slug,
        legalName,
        legalForm,
        sectorCode,
        defaultCurrency,
        rccm: rccm || null,
        idNat: idNat || null,
        taxIdDgi: taxIdDgi || null,
        cnssEmployerNumber: cnss || null,
        inppEmployerNumber: inpp || null,
        onemEmployerNumber: onem || null,
        isDemoTenant,
        headquartersSite: {
          code: hqCode,
          name: hqName,
          province: hqProvince,
          city: hqCity,
          timezone: hqTimezone,
        },
      });
      await switchTenant(created.tenant.id);
      await refreshProfile();
      await loadTenants();
      setSuccess(
        `Entreprise "${created.tenant.legalName}" provisionnée (politique biométrique DEVICE_ONLY active) et sélectionnée.`,
      );
      setShowForm(false);
      setLegalName('');
      setSlug('');
      setRccm('');
      setIdNat('');
      setTaxIdDgi('');
      setCnss('');
      setInpp('');
      setOnem('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur lors de la création.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus(tenant: TenantSummary) {
    const nextStatus = tenant.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    const reason = window.prompt(
      `Motif obligatoire pour passer "${tenant.legalName}" au statut ${nextStatus} :`,
      nextStatus === 'SUSPENDED'
        ? 'Suspension administrative décidée par la super-administration'
        : 'Réactivation administrative vérifiée',
    );
    if (!reason || reason.trim().length < 5) return;

    setError(null);
    try {
      await api.patch(`/platform/tenants/${tenant.id}/status`, { status: nextStatus, reason });
      await loadTenants();
      await refreshProfile();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur de mise à jour du statut.');
    }
  }

  if (!me?.user.isPlatformSuperadmin) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">
        Accès réservé au Super-Administrateur de la plateforme.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Entreprises clientes (Tenants SaaS)
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Provisionnement isolé par PostgreSQL Row-Level Security, clé d’enveloppe dédiée et
            politique biométrique <code className="font-mono">DEVICE_ONLY</code> par défaut.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-blue-800"
        >
          <Plus className="h-4 w-4" />
          {showForm ? 'Fermer le formulaire' : 'Nouvelle entreprise'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {success}
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-xs"
        >
          <h2 className="text-base font-semibold text-slate-900">
            Provisionner une entreprise et son établissement siège (RDC)
          </h2>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Raison sociale *</label>
              <input
                type="text"
                required
                value={legalName}
                onChange={(e) => {
                  setLegalName(e.target.value);
                  if (!slug) {
                    setSlug(
                      e.target.value
                        .toLowerCase()
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, '')
                        .slice(0, 40),
                    );
                  }
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Identifiant unique (slug) *
              </label>
              <input
                type="text"
                required
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="ex. groupe-congo-sarl"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Forme juridique *</label>
              <select
                value={legalForm}
                onChange={(e) => setLegalForm(e.target.value as (typeof LEGAL_FORMS)[number])}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {LEGAL_FORMS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Secteur d’activité</label>
              <select
                value={sectorCode}
                onChange={(e) => setSectorCode(e.target.value as (typeof SECTOR_CODES)[number])}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {SECTOR_CODES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Devise principale</label>
              <select
                value={defaultCurrency}
                onChange={(e) =>
                  setDefaultCurrency(e.target.value as (typeof SUPPORTED_CURRENCIES)[number])
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">RCCM</label>
              <input
                type="text"
                value={rccm}
                onChange={(e) => setRccm(e.target.value)}
                placeholder="CD/KNG/RCCM/..."
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Identification Nationale (Id. Nat.)
              </label>
              <input
                type="text"
                value={idNat}
                onChange={(e) => setIdNat(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Numéro Impôt (DGI)</label>
              <input
                type="text"
                value={taxIdDgi}
                onChange={(e) => setTaxIdDgi(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">N° Affiliation CNSS</label>
              <input
                type="text"
                value={cnss}
                onChange={(e) => setCnss(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">N° Employeur INPP</label>
              <input
                type="text"
                value={inpp}
                onChange={(e) => setInpp(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">N° Employeur ONEM</label>
              <input
                type="text"
                value={onem}
                onChange={(e) => setOnem(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-800">
              Établissement siège & fuseau horaire RDC
            </h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700">Code site *</label>
                <input
                  type="text"
                  required
                  value={hqCode}
                  onChange={(e) => setHqCode(e.target.value.toUpperCase())}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Nom du siège *</label>
                <input
                  type="text"
                  required
                  value={hqName}
                  onChange={(e) => setHqName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Province RDC *</label>
                <select
                  value={hqProvince}
                  onChange={(e) => handleProvinceChange(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  {DRC_PROVINCES.map((p) => (
                    <option key={p.code} value={p.name}>
                      {p.name} ({p.utcOffsetLabel})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Ville *</label>
                <input
                  type="text"
                  required
                  value={hqCity}
                  onChange={(e) => setHqCity(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Fuseau horaire assigné automatiquement :{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-800">
                {hqTimezone}
              </code>
            </p>
          </div>

          <label className="flex items-center gap-2.5 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={isDemoTenant}
              onChange={(e) => setIsDemoTenant(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            Marquer explicitement cette entreprise comme environnement <strong>[DÉMO / TEST]</strong>{' '}
            (séparation stricte avec les entreprises réelles).
          </label>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-blue-700 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
            >
              {submitting ? 'Provisionnement…' : 'Provisionner l’entreprise'}
            </button>
          </div>
        </form>
      )}

      {/* Liste des entreprises */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
        {tenants.length === 0 ? (
          <div className="p-10 text-center">
            <Building2 className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-2 text-sm font-medium text-slate-800">
              Aucune entreprise enregistrée pour le moment
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Aucune société fictive n’est pré-créée. Cliquez sur « Nouvelle entreprise » pour
              provisionner votre premier tenant isolé.
            </p>
          </div>
        ) : (
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3">Entreprise</th>
                <th className="px-5 py-3">Devise</th>
                <th className="px-5 py-3">Politique Biométrique</th>
                <th className="px-5 py-3">Statut</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tenants.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50/70">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900">{t.legalName}</span>
                      {t.isDemoTenant && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          DÉMO/TEST
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-xs text-slate-500">
                      {t.slug} · {t.legalForm} {t.rccm ? `· ${t.rccm}` : ''}
                    </p>
                  </td>
                  <td className="px-5 py-3.5 font-mono text-xs font-semibold text-slate-700">
                    {t.defaultCurrency}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="rounded bg-blue-50 px-2 py-0.5 font-mono text-xs font-medium text-blue-800">
                      {t.biometricStoragePolicy}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        t.status === 'ACTIVE'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-red-50 text-red-700'
                      }`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="inline-flex items-center gap-2">
                      {t.status === 'ACTIVE' && me.activeTenant?.id !== t.id && (
                        <button
                          type="button"
                          onClick={() => void switchTenant(t.id)}
                          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          Ouvrir
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleToggleStatus(t)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <Power className="h-3 w-3" />
                        {t.status === 'ACTIVE' ? 'Suspendre' : 'Réactiver'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
