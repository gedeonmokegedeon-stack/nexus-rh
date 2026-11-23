'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

export default function LoginPage() {
  const router = useRouter();
  const { loading, needsInitialSetup, me, applyAccessToken } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (needsInitialSetup) {
      router.replace('/setup');
    } else if (me) {
      router.replace('/dashboard');
    }
  }, [loading, needsInitialSetup, me, router]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post<
        | { status: 'MFA_REQUIRED'; mfaChallengeToken: string }
        | { status: 'AUTHENTICATED'; accessToken: string }
      >('/auth/login', { email, password });

      if (res.status === 'MFA_REQUIRED') {
        setMfaChallengeToken(res.mfaChallengeToken);
        setPassword('');
      } else {
        await applyAccessToken(res.accessToken);
        router.push('/dashboard');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de connexion.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaChallengeToken) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post<{ accessToken: string }>('/auth/mfa/verify', {
        mfaChallengeToken,
        code: mfaCode,
      });
      await applyAccessToken(res.accessToken);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Code MFA invalide.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0B1628] px-4 py-12">
      <div className="mb-8 flex items-center gap-3 text-white">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-lg font-bold shadow">
          N
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">NEXUS RH</h1>
          <p className="text-xs text-slate-400">Portail sécurisé RH · Présences · Paie RDC</p>
        </div>
      </div>

      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl">
        {!mfaChallengeToken ? (
          <>
            <h2 className="text-lg font-semibold text-slate-900">Connexion à votre espace</h2>
            <p className="mt-1 text-sm text-slate-600">
              Authentification protégée par Argon2id, jetons Ed25519 et isolation multi-entreprises.
            </p>

            {error && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </div>
            )}

            <form onSubmit={handleLogin} className="mt-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700">Adresse courriel</label>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Mot de passe</label>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:opacity-50"
              >
                <Lock className="h-4 w-4" />
                {submitting ? 'Vérification…' : 'Se connecter'}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-blue-700">
              <ShieldCheck className="h-5 w-5" />
              <h2 className="text-lg font-semibold text-slate-900">
                Vérification Multi-Facteurs (MFA)
              </h2>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Saisissez le code TOTP à 6 chiffres de votre application d’authentification ou un code
              de secours à usage unique (XXXX-XXXX).
            </p>

            {error && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </div>
            )}

            <form onSubmit={handleVerifyMfa} className="mt-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700">
                  Code TOTP ou code de secours
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder="000000 ou ABCD-1234"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-center font-mono text-lg tracking-widest focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:opacity-50"
              >
                <KeyRound className="h-4 w-4" />
                {submitting ? 'Validation…' : 'Valider le second facteur'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setMfaChallengeToken(null);
                  setMfaCode('');
                  setError(null);
                }}
                className="flex w-full items-center justify-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Retour à la saisie des identifiants
              </button>
            </form>
          </>
        )}
      </div>

      <p className="mt-8 text-xs text-slate-500">
        © 2026 NEXUS RH — Licence propriétaire commerciale · Tous droits réservés.
      </p>
    </div>
  );
}
