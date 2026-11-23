'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Clock, Fingerprint, MapPin, Plus } from 'lucide-react';
import { DRC_PROVINCES, SITE_TYPES } from '@nexus-rh/shared-types';
import { api, ApiError, type TenantSummary } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

interface SiteItem {
  id: string;
  code: string;
  name: string;
  siteType: string;
  province: string;
  city: string;
  timezone: string;
  geofenceRadiusMeters: number | null;
  isHeadquarters: boolean;
  status: string;
}

interface DepartmentItem {
  id: string;
  code: string;
  name: string;
  siteId: string | null;
  status: string;
}

function formatLocalTime(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('fr-CD', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'shortOffset',
    }).format(new Date());
  } catch {
    return timezone;
  }
}

export default function OrganizationPage() {
  const { me, hasPermission } = useAuth();
  const [profile, setProfile] = useState<TenantSummary | null>(null);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Formulaire nouveau site
  const [showSiteForm, setShowSiteForm] = useState(false);
  const [siteCode, setSiteCode] = useState('');
  const [siteName, setSiteName] = useState('');
  const [siteType, setSiteType] = useState<(typeof SITE_TYPES)[number]>('BRANCH');
  const [province, setProvince] = useState('Haut-Katanga');
  const [city, setCity] = useState('Lubumbashi');
  const [timezone, setTimezone] = useState('Africa/Lubumbashi');
  const [geofence, setGeofence] = useState('200');

  // Formulaire nouveau département
  const [deptCode, setDeptCode] = useState('');
  const [deptName, setDeptName] = useState('');
  const [deptSiteId, setDeptSiteId] = useState('');

  // Gouvernance biométrique (verrouillée MFA + référence légale)
  const [showBioForm, setShowBioForm] = useState(false);
  const [bioPolicy, setBioPolicy] = useState<'DEVICE_ONLY' | 'ENCRYPTED_CENTRAL_SYNC'>(
    'DEVICE_ONLY',
  );
  const [bioLegalRef, setBioLegalRef] = useState('');
  const [bioReason, setBioReason] = useState('');

  // Édition du profil légal RDC
  const [editingProfile, setEditingProfile] = useState(false);
  const [editRccm, setEditRccm] = useState('');
  const [editIdNat, setEditIdNat] = useState('');
  const [editTaxId, setEditTaxId] = useState('');
  const [editCnss, setEditCnss] = useState('');
  const [editInpp, setEditInpp] = useState('');
  const [editOnem, setEditOnem] = useState('');

  const loadData = useCallback(async () => {
    if (!me?.activeTenant) return;
    setError(null);
    try {
      const [profRes, sitesRes, deptRes] = await Promise.all([
        api.get<{ tenant: TenantSummary }>('/tenant/profile'),
        api.get<{ sites: SiteItem[] }>('/sites'),
        api.get<{ departments: DepartmentItem[] }>('/departments'),
      ]);
      setProfile(profRes.tenant);
      setSites(sitesRes.sites);
      setDepartments(deptRes.departments);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur de chargement.');
    }
  }, [me?.activeTenant]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleCreateSite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.post('/sites', {
        code: siteCode,
        name: siteName,
        siteType,
        province,
        city,
        timezone,
        geofenceRadiusMeters: geofence ? Number(geofence) : null,
      });
      setSiteCode('');
      setSiteName('');
      setShowSiteForm(false);
      setMessage('Établissement ajouté et journalisé dans la chaîne d’audit.');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de créer l’établissement.');
    }
  }

  async function handleCreateDepartment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.post('/departments', {
        code: deptCode,
        name: deptName,
        siteId: deptSiteId || null,
      });
      setDeptCode('');
      setDeptName('');
      setDeptSiteId('');
      setMessage('Département créé.');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de créer le département.');
    }
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.patch('/tenant/profile', {
        rccm: editRccm || null,
        idNat: editIdNat || null,
        taxIdDgi: editTaxId || null,
        cnssEmployerNumber: editCnss || null,
        inppEmployerNumber: editInpp || null,
        onemEmployerNumber: editOnem || null,
      });
      setEditingProfile(false);
      setMessage('Profil légal RDC mis à jour et journalisé.');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de mettre à jour le profil.');
    }
  }

  async function handleSaveBiometricPolicy(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.patch('/tenant/biometric-policy', {
        policy: bioPolicy,
        centralTemplateStorageEnabled: bioPolicy === 'ENCRYPTED_CENTRAL_SYNC',
        legalAuthorizationRef: bioPolicy === 'ENCRYPTED_CENTRAL_SYNC' ? bioLegalRef : null,
        reason: bioReason,
      });
      setShowBioForm(false);
      setBioReason('');
      setMessage('Politique biométrique mise à jour et scellée dans le journal d’audit.');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Modification refusée par les garde-fous.');
    }
  }

  if (!me?.activeTenant) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-600">
        Sélectionnez ou créez d’abord une entreprise active.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Établissements Multi-Sites & Gouvernance — {profile?.legalName ?? me.activeTenant.legalName}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Gestion des implantations RDC (fuseaux <code className="font-mono">Africa/Kinshasa</code>{' '}
            UTC+1 et <code className="font-mono">Africa/Lubumbashi</code> UTC+2), départements et
            politique biométrique.
          </p>
        </div>
        {hasPermission('organization.sites.manage') && (
          <button
            type="button"
            onClick={() => setShowSiteForm((v) => !v)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
          >
            <Plus className="h-4 w-4" />
            Nouvel établissement
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {message}
        </div>
      )}

      {/* Identité légale RDC & Politique biométrique DEVICE_ONLY */}
      {profile && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
                Identité légale & immatriculations RDC
              </h2>
              {hasPermission('tenant.update') && (
                <button
                  type="button"
                  onClick={() => {
                    if (!editingProfile) {
                      setEditRccm(profile.rccm ?? '');
                      setEditIdNat(profile.idNat ?? '');
                      setEditTaxId(profile.taxIdDgi ?? '');
                      setEditCnss(profile.cnssEmployerNumber ?? '');
                      setEditInpp(profile.inppEmployerNumber ?? '');
                      setEditOnem(profile.onemEmployerNumber ?? '');
                    }
                    setEditingProfile((v) => !v);
                  }}
                  className="text-xs font-semibold text-blue-700 hover:underline"
                >
                  {editingProfile ? 'Annuler' : 'Modifier'}
                </button>
              )}
            </div>
            {editingProfile ? (
              <form onSubmit={handleSaveProfile} className="mt-3 grid gap-3 sm:grid-cols-3">
                <input
                  value={editRccm}
                  onChange={(e) => setEditRccm(e.target.value)}
                  placeholder="RCCM (CD/KNG/...)"
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
                />
                <input
                  value={editIdNat}
                  onChange={(e) => setEditIdNat(e.target.value)}
                  placeholder="Id. Nat."
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
                />
                <input
                  value={editTaxId}
                  onChange={(e) => setEditTaxId(e.target.value)}
                  placeholder="N° Impôt DGI"
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
                />
                <input
                  value={editCnss}
                  onChange={(e) => setEditCnss(e.target.value)}
                  placeholder="N° CNSS"
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
                />
                <input
                  value={editInpp}
                  onChange={(e) => setEditInpp(e.target.value)}
                  placeholder="N° INPP"
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
                />
                <input
                  value={editOnem}
                  onChange={(e) => setEditOnem(e.target.value)}
                  placeholder="N° ONEM"
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
                />
                <div className="sm:col-span-3 flex justify-end">
                  <button
                    type="submit"
                    className="rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800"
                  >
                    Enregistrer les immatriculations
                  </button>
                </div>
              </form>
            ) : (
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-slate-500">Forme / Devise</dt>
                  <dd className="font-medium text-slate-900">
                    {profile.legalForm} · {profile.defaultCurrency}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">RCCM</dt>
                  <dd className="font-mono text-xs text-slate-800">
                    {profile.rccm || 'Non renseigné'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Id. Nat. / NIF DGI</dt>
                  <dd className="font-mono text-xs text-slate-800">
                    {profile.idNat || '—'} / {profile.taxIdDgi || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">CNSS</dt>
                  <dd className="font-mono text-xs text-slate-800">
                    {profile.cnssEmployerNumber || 'Non renseigné'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">INPP / ONEM</dt>
                  <dd className="font-mono text-xs text-slate-800">
                    {profile.inppEmployerNumber || '—'} / {profile.onemEmployerNumber || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Modèle matricule</dt>
                  <dd className="font-mono text-xs text-slate-800">{profile.matriculePattern}</dd>
                </div>
              </dl>
            )}
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-5">
            <div className="flex items-center justify-between gap-2 text-blue-900">
              <div className="flex items-center gap-2">
                <Fingerprint className="h-4 w-4 text-blue-700" />
                <h2 className="text-sm font-semibold">Conformité Biométrique RDC</h2>
              </div>
              {hasPermission('tenant.biometric_policy.manage') && (
                <button
                  type="button"
                  onClick={() => {
                    setBioPolicy(
                      profile.biometricStoragePolicy === 'ENCRYPTED_CENTRAL_SYNC'
                        ? 'ENCRYPTED_CENTRAL_SYNC'
                        : 'DEVICE_ONLY',
                    );
                    setShowBioForm((v) => !v);
                  }}
                  className="text-[11px] font-semibold text-blue-800 hover:underline"
                >
                  {showBioForm ? 'Fermer' : 'Gouvernance'}
                </button>
              )}
            </div>
            <p className="mt-2 font-mono text-sm font-bold text-blue-950">
              {profile.biometricStoragePolicy}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-700">
              Stockage central de gabarits :{' '}
              <strong>
                {profile.centralTemplateStorageEnabled
                  ? 'Activé (autorisé APD)'
                  : 'DÉSACTIVÉ (verrou SQL)'}
              </strong>
              . Les gabarits demeurent sur les terminaux locaux ; alternative QR Code / PIN garantie.
            </p>
            {showBioForm && (
              <form
                onSubmit={handleSaveBiometricPolicy}
                className="mt-3 space-y-2 border-t border-blue-200 pt-3 text-xs"
              >
                <select
                  value={bioPolicy}
                  onChange={(e) =>
                    setBioPolicy(e.target.value as 'DEVICE_ONLY' | 'ENCRYPTED_CENTRAL_SYNC')
                  }
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5"
                >
                  <option value="DEVICE_ONLY">DEVICE_ONLY (défaut recommandé RDC)</option>
                  <option value="ENCRYPTED_CENTRAL_SYNC">
                    ENCRYPTED_CENTRAL_SYNC (exige MFA + réf. légale APD)
                  </option>
                </select>
                {bioPolicy === 'ENCRYPTED_CENTRAL_SYNC' && (
                  <input
                    type="text"
                    required
                    minLength={5}
                    value={bioLegalRef}
                    onChange={(e) => setBioLegalRef(e.target.value)}
                    placeholder="Référence autorisation légale APD RDC *"
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1.5"
                  />
                )}
                <input
                  type="text"
                  required
                  minLength={10}
                  value={bioReason}
                  onChange={(e) => setBioReason(e.target.value)}
                  placeholder="Motif d’audit obligatoire (min. 10 car.) *"
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5"
                />
                <button
                  type="submit"
                  className="w-full rounded bg-blue-800 px-3 py-1.5 font-semibold text-white hover:bg-blue-900"
                >
                  Appliquer (contrôle MFA + SQL)
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {showSiteForm && (
        <form
          onSubmit={handleCreateSite}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-xs"
        >
          <h2 className="text-base font-semibold text-slate-900">Ajouter un établissement / site</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Code site *</label>
              <input
                type="text"
                required
                value={siteCode}
                onChange={(e) => setSiteCode(e.target.value.toUpperCase())}
                placeholder="ex. LUB-01, GOM-AG1"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Nom *</label>
              <input
                type="text"
                required
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                placeholder="ex. Succursale Lubumbashi"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Type de site</label>
              <select
                value={siteType}
                onChange={(e) => setSiteType(e.target.value as (typeof SITE_TYPES)[number])}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {SITE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Province RDC *</label>
              <select
                value={province}
                onChange={(e) => {
                  const val = e.target.value;
                  setProvince(val);
                  const p = DRC_PROVINCES.find((x) => x.name === val);
                  if (p) setTimezone(p.defaultTimezone);
                }}
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
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Rayon géorepérage (mètres)
              </label>
              <input
                type="number"
                min={20}
                max={50000}
                value={geofence}
                onChange={(e) => setGeofence(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-slate-500">
              Fuseau IANA : <code className="font-mono font-semibold">{timezone}</code>
            </span>
            <button
              type="submit"
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
            >
              Enregistrer l’établissement
            </button>
          </div>
        </form>
      )}

      {/* Tableau des établissements */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
        <div className="border-b border-slate-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">
            Établissements autorisés ({sites.length})
          </h2>
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-5 py-3">Code & Nom</th>
              <th className="px-5 py-3">Localisation</th>
              <th className="px-5 py-3">Fuseau & Heure locale</th>
              <th className="px-5 py-3">Géorepérage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sites.map((s) => (
              <tr key={s.id}>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-blue-600" />
                    <span className="font-mono text-xs font-bold text-slate-800">{s.code}</span>
                    <span className="font-medium text-slate-900">{s.name}</span>
                    {s.isHeadquarters && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                        SIÈGE
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-5 py-3 text-slate-700">
                  {s.city}, {s.province}
                </td>
                <td className="px-5 py-3">
                  <span className="inline-flex items-center gap-1.5 rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-800">
                    <Clock className="h-3 w-3 text-slate-500" />
                    {s.timezone} · {formatLocalTime(s.timezone)}
                  </span>
                </td>
                <td className="px-5 py-3 text-xs text-slate-600">
                  {s.geofenceRadiusMeters ? `${s.geofenceRadiusMeters} m` : 'Optionnel'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Départements */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <h2 className="text-sm font-semibold text-slate-900">
          Départements & Services ({departments.length})
        </h2>

        {hasPermission('organization.departments.manage') && (
          <form onSubmit={handleCreateDepartment} className="mt-4 flex flex-wrap gap-3">
            <input
              type="text"
              required
              value={deptCode}
              onChange={(e) => setDeptCode(e.target.value.toUpperCase())}
              placeholder="Code (ex. DRH)"
              className="w-36 rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
            />
            <input
              type="text"
              required
              value={deptName}
              onChange={(e) => setDeptName(e.target.value)}
              placeholder="Intitulé du département"
              className="min-w-56 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <select
              value={deptSiteId}
              onChange={(e) => setDeptSiteId(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Transverse (tous les sites)</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.city}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Ajouter
            </button>
          </form>
        )}

        {departments.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {departments.map((d) => (
              <span
                key={d.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-800"
              >
                <strong className="font-mono">{d.code}</strong> · {d.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
