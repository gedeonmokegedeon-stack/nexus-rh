'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

interface AuditEntry {
  id: string;
  seqNo: number;
  chainScope: string;
  actorType: string;
  actorEmail: string | null;
  actorRole: string | null;
  ipAddress: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  beforeState: unknown;
  afterState: unknown;
  prevHash: string;
  entryHash: string;
  occurredAt: string;
}

interface VerificationReport {
  scope: string;
  verifiedAt: string;
  algorithm: string;
  valid: boolean;
  checkedCount: number;
  headHash: string;
  failureReason: string | null;
}

export default function AuditLogPage() {
  const { me, hasPermission } = useAuth();
  const canViewTenant = Boolean(me?.activeTenant) && hasPermission('audit.read');
  const canViewPlatform = Boolean(me?.user.isPlatformSuperadmin);

  const [scope, setScope] = useState<'tenant' | 'platform'>(
    canViewTenant ? 'tenant' : 'platform',
  );
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    setError(null);
    try {
      const query = scope === 'platform' ? '?scope=platform&limit=50' : '?limit=50';
      const res = await api.get<{ logs: AuditEntry[] }>(`/audit/logs${query}`);
      setLogs(res.logs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de lire le journal d’audit.');
    }
  }, [scope]);

  const runVerify = useCallback(async () => {
    setVerifying(true);
    setError(null);
    try {
      const query = scope === 'platform' ? '?scope=platform' : '';
      const res = await api.get<VerificationReport>(`/audit/verify${query}`);
      setReport(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur de vérification cryptographique.');
    } finally {
      setVerifying(false);
    }
  }, [scope]);

  useEffect(() => {
    if (scope === 'tenant' && !canViewTenant && canViewPlatform) {
      setScope('platform');
      return;
    }
    void loadLogs();
    void runVerify();
  }, [scope, canViewTenant, canViewPlatform, loadLogs, runVerify]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Journal d’audit immuable (chaîné SHA-256)
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Protégé contre tout UPDATE/DELETE par déclencheur PostgreSQL, isolé par RLS et expurgé
            automatiquement des secrets.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {canViewTenant && canViewPlatform && (
            <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-medium">
              <button
                type="button"
                onClick={() => setScope('tenant')}
                className={`rounded-md px-3 py-1.5 ${
                  scope === 'tenant' ? 'bg-slate-900 text-white' : 'text-slate-600'
                }`}
              >
                Entreprise active
              </button>
              <button
                type="button"
                onClick={() => setScope('platform')}
                className={`rounded-md px-3 py-1.5 ${
                  scope === 'platform' ? 'bg-slate-900 text-white' : 'text-slate-600'
                }`}
              >
                Plateforme SaaS
              </button>
            </div>
          )}

          <button
            type="button"
            disabled={verifying}
            onClick={() => {
              void loadLogs();
              void runVerify();
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${verifying ? 'animate-spin' : ''}`} />
            Revérifier la chaîne SHA-256
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {report && (
        <div
          className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4 text-sm ${
            report.valid
              ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
              : 'border-red-300 bg-red-50 text-red-950'
          }`}
        >
          <div className="flex items-center gap-3">
            {report.valid ? (
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
            ) : (
              <ShieldAlert className="h-5 w-5 shrink-0 text-red-600" />
            )}
            <div>
              <p className="font-semibold">
                {report.valid
                  ? `Intégrité cryptographique confirmée (${report.checkedCount} entrée(s) recalculées de la genèse à la tête)`
                  : `ALERTE INTÉGRITÉ : ${report.failureReason}`}
              </p>
              <p className="font-mono text-xs opacity-80">
                Empreinte de tête ({report.algorithm}) : {report.headHash.slice(0, 32)}…
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-medium">
            <ShieldCheck className="h-4 w-4" />
            Vérifié à {new Date(report.verifiedAt).toLocaleTimeString('fr-CD')}
          </span>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Horodatage UTC</th>
              <th className="px-4 py-3">Action & Ressource</th>
              <th className="px-4 py-3">Acteur</th>
              <th className="px-4 py-3">Chaînage SHA-256</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {logs.map((entry) => {
              const isExpanded = expandedId === entry.id;
              return (
                <React.Fragment key={entry.id}>
                  <tr
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    className="cursor-pointer align-top hover:bg-slate-50/80"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">#{entry.seqNo}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600">
                      {new Date(entry.occurredAt).toISOString().replace('T', ' ').slice(0, 19)}Z
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-900">
                        {entry.action}
                      </span>
                      <span className="ml-2 text-xs text-slate-500">{entry.resourceType}</span>
                      {entry.reason && (
                        <p className="mt-1 text-xs italic text-slate-600">Motif : {entry.reason}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <p className="font-medium text-slate-800">
                        {entry.actorEmail ?? entry.actorType}
                      </p>
                      <p className="text-slate-400">IP {entry.ipAddress ?? '—'}</p>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                      <div>prev: {entry.prevHash.slice(0, 14)}…</div>
                      <div className="text-slate-800">hash: {entry.entryHash.slice(0, 14)}…</div>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-slate-50/90">
                      <td colSpan={5} className="px-4 py-3 text-xs">
                        <div className="grid gap-3 md:grid-cols-2">
                          <div>
                            <p className="mb-1 font-semibold text-slate-600">
                              État avant (expurgé des secrets)
                            </p>
                            <pre className="max-h-48 overflow-auto rounded border border-slate-200 bg-white p-2.5 font-mono text-[11px] text-slate-800">
                              {JSON.stringify(entry.beforeState ?? null, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <p className="mb-1 font-semibold text-slate-600">
                              État après (expurgé des secrets)
                            </p>
                            <pre className="max-h-48 overflow-auto rounded border border-slate-200 bg-white p-2.5 font-mono text-[11px] text-slate-800">
                              {JSON.stringify(entry.afterState ?? null, null, 2)}
                            </pre>
                          </div>
                        </div>
                        <p className="mt-2 font-mono text-[11px] text-slate-500">
                          SHA-256 complet : {entry.entryHash}
                        </p>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
