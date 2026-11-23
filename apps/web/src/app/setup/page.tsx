'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Circle, Lock, ShieldCheck, Server } from 'lucide-react';
import { api, ApiError, type HealthResponse } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

export default function InitialSetupPage() {
  const router = useRouter();
  const { loading, needsInitialSetup, me, applyAccessToken } = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<HealthResponse>('/health')
      .then(setHealth)
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!needsInitialSetup) {
      router.replace(me ? '/dashboard' : '/login');
    }
  }, [loading, needsInitialSetup, me, router]);

  const rules = [
    { label: '12 caractères minimum', ok: password.length >= 12 },
    { label: 'Au moins une majuscule et une minuscule', ok: /[A-Z]/.test(password) && /[a-z]/.test(password) },
    { label: 'Au moins un chiffre', ok: /[0-9]/.test(password) },
    { label: 'Au moins un caractère spécial', ok: /[^A-Za-z0-9]/.test(password) },
    { label: 'Confirmation identique', ok: password.length > 0 && password === confirmPassword },
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError('Les deux mots de passe ne correspondent pas.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post<{ accessToken: string }>('/auth/bootstrap', {
        fullName,
        email,
        password,
      });
      await applyAccessToken(res.accessToken);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur lors de l’initialisation.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-12">
      {/* Colonne institutionnelle gauche */}
      <aside className="flex flex-col justify-between bg-[#0B1628] p-8 text-white lg:col-span-5 lg:p-12">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 font-bold text-white shadow-sm">
              N
            </div>
            <div>
              <p className="text-lg font-bold tracking-tight">NEXUS RH</p>
              <p className="text-xs text-slate-400">
                Plateforme SaaS RH · Présences Biométriques · Paie RDC
              </p>
            </div>
          </div>

          <div className="mt-10 space-y-4">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Socle Mission 1 — Base vierge vérifiée
            </span>
            <h1 className="text-2xl font-semibold leading-snug tracking-tight lg:text-3xl">
              Initialisation unique de la Super-Administration
            </h1>
            <p className="text-sm leading-relaxed text-slate-300">
              Aucune donnée fictive ni aucun compte par défaut n’est pré-chargé. Créez le premier
              compte propriétaire : cet assistant sera automatiquement et définitivement verrouillé
              dès validation, avec inscription dans la chaîne d’audit SHA-256.
            </p>
          </div>
        </div>

        {/* Panneau d'état réel vérifié de l'infrastructure */}
        <div className="mt-10 rounded-xl border border-slate-800 bg-slate-900/70 p-5 text-xs">
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-2 font-semibold text-slate-200">
              <Server className="h-4 w-4 text-blue-400" />
              État réel du socle technique
            </span>
            {health && (
              <span className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] text-amber-300">
                PROFIL : {health.infraProfile.toUpperCase()}
              </span>
            )}
          </div>
          {health ? (
            <dl className="space-y-2 text-slate-300">
              <div className="flex justify-between">
                <dt className="text-slate-400">Moteur PostgreSQL</dt>
                <dd className="font-mono text-emerald-300">
                  v{health.components.database.pgVersion} ({health.components.database.adapter})
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Isolation FORCE RLS</dt>
                <dd className="font-mono text-emerald-300">
                  {health.components.database.forceRlsTablesCount} tables protégées
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Politique biométrique par défaut</dt>
                <dd className="font-mono text-slate-100">
                  {health.governance.defaultBiometricStoragePolicy}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Hachage & signature</dt>
                <dd className="font-mono text-slate-100">Argon2id · Ed25519 · AES-256-GCM</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Connecteurs biométriques</dt>
                <dd className="font-mono text-slate-300">SPECIFIED (non simulés)</dd>
              </div>
            </dl>
          ) : (
            <p className="text-slate-400">Vérification de l’API en cours…</p>
          )}
        </div>
      </aside>

      {/* Formulaire d'initialisation */}
      <main className="flex items-center justify-center p-6 lg:col-span-7 lg:p-12">
        <div className="w-full max-w-md">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-slate-900">
              Créer le compte Super-Administrateur
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Après la création, vous pourrez activer votre MFA TOTP et provisionner vos premières
              entreprises et établissements.
            </p>
          </div>

          {error && (
            <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700">Nom complet</label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Ex. Administrateur Principal"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-xs focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">
                Adresse courriel professionnelle
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="direction@votre-domaine.cd"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-xs focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">
                Mot de passe maître (haché Argon2id)
              </label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-xs focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">
                Confirmer le mot de passe
              </label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-xs focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Exigences de sécurité
              </p>
              <ul className="space-y-1.5 text-xs">
                {rules.map((r) => (
                  <li
                    key={r.label}
                    className={`flex items-center gap-2 ${r.ok ? 'text-emerald-700 font-medium' : 'text-slate-500'}`}
                  >
                    {r.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Circle className="h-3.5 w-3.5 text-slate-400" />
                    )}
                    {r.label}
                  </li>
                ))}
              </ul>
            </div>

            <button
              type="submit"
              disabled={submitting || !rules.every((r) => r.ok)}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white shadow-xs transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Lock className="h-4 w-4" />
              {submitting
                ? 'Chiffrement et initialisation en cours…'
                : 'Initialiser la plateforme NEXUS RH'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-slate-400">
            NEXUS RH — Logiciel propriétaire commercial · Tous droits réservés.
          </p>
        </div>
      </main>
    </div>
  );
}
