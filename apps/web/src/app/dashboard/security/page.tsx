'use client';

import React, { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { CheckCircle2, KeyRound, MonitorSmartphone, ShieldCheck, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

interface SessionItem {
  id: string;
  mfaVerified: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export default function SecurityPage() {
  const { me, applyAccessToken } = useAuth();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [setupData, setSetupData] = useState<{
    secretBase32: string;
    otpauthUri: string;
    qrDataUrl: string;
  } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await api.get<{ sessions: SessionItem[] }>('/auth/sessions');
      setSessions(res.sessions);
    } catch {
      // Ignorer
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  async function handleStartMfa() {
    setError(null);
    try {
      const res = await api.post<{ secretBase32: string; otpauthUri: string }>('/auth/mfa/setup');
      // Génération 100 % locale du QR Code (le secret TOTP n'est jamais envoyé à un service tiers)
      const qrDataUrl = await QRCode.toDataURL(res.otpauthUri, { width: 200, margin: 1 });
      setSetupData({ ...res, qrDataUrl });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur d’initialisation MFA.');
    }
  }

  async function handleEnableMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.post<{ recoveryCodes: string[]; accessToken: string }>(
        '/auth/mfa/enable',
        { code: totpCode },
      );
      setRecoveryCodes(res.recoveryCodes);
      setSetupData(null);
      setTotpCode('');
      await applyAccessToken(res.accessToken);
      await loadSessions();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Code TOTP invalide.');
    }
  }

  async function handleRevokeSession(id: string) {
    try {
      await api.del(`/auth/sessions/${id}`);
      await loadSessions();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur de révocation.');
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Sécurité du compte, MFA TOTP & Sessions actives
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Secret TOTP chiffré par enveloppe AES-256-GCM ; sessions protégées par rotation de Refresh
          Tokens et détection automatique de réutilisation.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Carte MFA TOTP */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-blue-700" />
            <h2 className="text-base font-semibold text-slate-900">
              Authentification Multi-Facteurs (TOTP RFC 6238)
            </h2>
          </div>
          {me?.user.mfaEnabled ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> Activée
            </span>
          ) : (
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
              Non activée
            </span>
          )}
        </div>

        {!me?.user.mfaEnabled && !setupData && (
          <div className="mt-4">
            <p className="text-sm text-slate-600">
              Protégez votre compte avec Google Authenticator, Microsoft Authenticator, FreeOTP,
              Bitwarden ou 1Password.
            </p>
            <button
              type="button"
              onClick={() => void handleStartMfa()}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
            >
              <KeyRound className="h-4 w-4" /> Générer ma clé MFA TOTP
            </button>
          </div>
        )}

        {setupData && (
          <div className="mt-5 grid gap-6 border-t border-slate-100 pt-5 sm:grid-cols-2">
            <div className="flex flex-col items-center rounded-lg border border-slate-200 bg-slate-50 p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={setupData.qrDataUrl}
                alt="QR Code TOTP généré localement"
                className="h-44 w-44 rounded border border-slate-200 bg-white p-2"
              />
              <p className="mt-3 text-center text-[11px] text-slate-500">
                Clé manuelle Base32 :
              </p>
              <code className="mt-1 break-all rounded bg-white px-2 py-1 font-mono text-xs text-slate-900 ring-1 ring-slate-200">
                {setupData.secretBase32}
              </code>
            </div>

            <form onSubmit={handleEnableMfa} className="flex flex-col justify-center space-y-4">
              <p className="text-sm text-slate-700">
                Scannez le QR Code avec votre application puis saisissez le code à 6 chiffres
                affiché pour confirmer l’activation :
              </p>
              <input
                type="text"
                required
                pattern="\d{6}"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-center font-mono text-lg tracking-widest"
              />
              <button
                type="submit"
                className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                Activer la MFA et générer les codes de secours
              </button>
            </form>
          </div>
        )}

        {recoveryCodes && (
          <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-950">
              Conservez immédiatement ces 8 codes de secours à usage unique (ils ne seront plus
              jamais affichés en clair) :
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {recoveryCodes.map((code) => (
                <code
                  key={code}
                  className="rounded bg-white px-2.5 py-1.5 text-center font-mono text-xs font-bold text-slate-900 ring-1 ring-amber-200"
                >
                  {code}
                </code>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Sessions actives */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <div className="flex items-center gap-2.5">
          <MonitorSmartphone className="h-5 w-5 text-slate-700" />
          <h2 className="text-base font-semibold text-slate-900">
            Sessions actives ({sessions.length})
          </h2>
        </div>

        <div className="mt-4 divide-y divide-slate-100 text-sm">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-slate-800">
                    IP : {s.ipAddress ?? 'inconnue'}
                  </span>
                  {s.isCurrent && (
                    <span className="rounded bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                      Session courante
                    </span>
                  )}
                  {s.mfaVerified && (
                    <span className="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      MFA vérifiée
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">{s.userAgent}</p>
                <p className="text-[11px] text-slate-400">
                  Ouverte le {new Date(s.createdAt).toLocaleString('fr-CD')}
                </p>
              </div>
              {!s.isCurrent && (
                <button
                  type="button"
                  onClick={() => void handleRevokeSession(s.id)}
                  className="inline-flex items-center gap-1 rounded border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-3 w-3" /> Révoquer
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
