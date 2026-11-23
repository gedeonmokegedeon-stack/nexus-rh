'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  Database,
  Fingerprint,
  IdCard,
  Lock,
  ShieldCheck,
  ArrowRight,
} from 'lucide-react';
import { api, type HealthResponse } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

interface AuditVerifyResponse {
  valid: boolean;
  checkedCount: number;
  headHash: string;
  algorithm: string;
}

const VENDOR_LABELS: Record<string, string> = {
  KIOSK_PWA_QR_PIN: '1. PWA Tablette (QR Code + PIN)',
  ZKTECO: '2. ZKTeco (ADMS Push / Edge LAN)',
  HIKVISION: '3. Hikvision (ISAPI / ISUP)',
  ANVIZ: '4. Anviz (Cloud / TCP 5010)',
  SUPREMA: '5. Suprema (G-SDK / BioStar 2)',
  OTHER: '6. Autres fabricants',
};

export default function DashboardOverviewPage() {
  const { me, hasPermission } = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [auditCheck, setAuditCheck] = useState<AuditVerifyResponse | null>(null);
  const [activeEmployeesCount, setActiveEmployeesCount] = useState<number | null>(null);

  useEffect(() => {
    void api
      .get<HealthResponse>('/health')
      .then(setHealth)
      .catch(() => null);

    if (me?.activeTenant && hasPermission('employees.read')) {
      void api
        .get<{ employees: Array<{ id: string }> }>('/employees?status=ACTIVE')
        .then((res) => setActiveEmployeesCount(res.employees.length))
        .catch(() => setActiveEmployeesCount(null));
    } else {
      setActiveEmployeesCount(null);
    }

    if (me?.activeTenant && hasPermission('audit.read')) {
      void api
        .get<AuditVerifyResponse>('/audit/verify')
        .then(setAuditCheck)
        .catch(() => null);
    } else if (me?.user.isPlatformSuperadmin) {
      void api
        .get<AuditVerifyResponse>('/audit/verify?scope=platform')
        .then(setAuditCheck)
        .catch(() => null);
    }
  }, [me, hasPermission]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Tableau de bord — Cœur RH RDC, Sécurité & Multi-Entreprises
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Données réelles interrogées en direct depuis PostgreSQL (aucun compteur ni employé fictif).
        </p>
      </div>

      {/* Indicateurs réels (Missions 1 & 2) */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Effectif actif</span>
            <IdCard className="h-4 w-4 text-blue-600" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {activeEmployeesCount !== null ? `${activeEmployeesCount}` : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {me?.activeTenant
              ? 'Agents actifs dans votre périmètre'
              : 'Sélectionnez une entreprise'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Isolation RLS</span>
            <Database className="h-4 w-4 text-blue-600" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {health ? `${health.components.database.forceRlsTablesCount} tables` : '—'}
          </p>
          <p className="mt-1 text-xs text-emerald-700">
            {health
              ? `PostgreSQL ${health.components.database.pgVersion} · FORCE RLS actif`
              : 'Vérification…'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-semibold uppercase tracking-wider">
              Chaîne d’audit SHA-256
            </span>
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {auditCheck ? (auditCheck.valid ? 'INTÈGRE' : 'ALERTE') : 'Protégée'}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {auditCheck
              ? `${auditCheck.checkedCount} événement(s) chaînés vérifiés`
              : 'Accès selon permission audit.read'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-semibold uppercase tracking-wider">
              Biométrie (RDC)
            </span>
            <Fingerprint className="h-4 w-4 text-blue-600" />
          </div>
          <p className="mt-2 text-lg font-bold text-slate-900">
            {me?.activeTenant?.biometricStoragePolicy ?? 'DEVICE_ONLY'}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            Stockage local sur terminal par défaut strict
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-semibold uppercase tracking-wider">
              Authentification
            </span>
            <Lock className="h-4 w-4 text-slate-700" />
          </div>
          <p className="mt-2 text-lg font-bold text-slate-900">
            {me?.user.mfaEnabled ? 'MFA TOTP Active' : 'Mot de passe seul'}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {me?.permissions.length ?? 0} permission(s) résolue(s)
          </p>
        </div>
      </div>

      {/* Actions rapides selon le contexte */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
          <h2 className="text-base font-semibold text-slate-900">
            Composants d’infrastructure (Ports & Adapters)
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            État transparent rapporté par <code className="font-mono">/api/v1/health</code>.
          </p>

          {health && (
            <div className="mt-4 divide-y divide-slate-100 text-sm">
              {[
                {
                  label: 'Base de données relationnelle',
                  adapter: `${health.components.database.adapter} (PG ${health.components.database.pgVersion})`,
                  sandbox: health.components.database.isSandboxFallback,
                  ok: health.components.database.ok,
                },
                {
                  label: 'Cache, sessions & verrous',
                  adapter: health.components.cache.adapter,
                  sandbox: health.components.cache.isSandboxFallback,
                  ok: health.components.cache.ok,
                },
                {
                  label: 'Bus de messages asynchrone',
                  adapter: health.components.messageBus.adapter,
                  sandbox: health.components.messageBus.isSandboxFallback,
                  ok: health.components.messageBus.ok,
                },
                {
                  label: 'Stockage documentaire S3',
                  adapter: health.components.objectStorage.adapter,
                  sandbox: health.components.objectStorage.isSandboxFallback,
                  ok: health.components.objectStorage.ok,
                },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="font-medium text-slate-800">{item.label}</p>
                    <p className="font-mono text-xs text-slate-500">{item.adapter}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.sandbox && (
                      <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">
                        Mode Sandbox
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                      <CheckCircle2 className="h-4 w-4" />
                      {item.ok ? 'Actif' : 'Dégradé'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-5 flex flex-wrap gap-3 border-t border-slate-100 pt-4">
            {me?.activeTenant && hasPermission('employees.read') && (
              <Link
                href="/dashboard/employees"
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800"
              >
                Dossiers Employés RDC <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
            {me?.user.isPlatformSuperadmin && (
              <Link
                href="/dashboard/tenants"
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100"
              >
                Gérer les entreprises clientes <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
            {me?.activeTenant && hasPermission('organization.sites.read') && (
              <Link
                href="/dashboard/organization"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Configurer les établissements RDC
              </Link>
            )}
            <Link
              href="/dashboard/security"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Sécurité & MFA TOTP
            </Link>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
          <h2 className="text-base font-semibold text-slate-900">
            État honnête des connecteurs de pointage (ordre validé)
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Conformément à la politique NEXUS RH, aucun connecteur n’est déclaré opérationnel sans
            homologation sur matériel réel.
          </p>

          <div className="mt-4 divide-y divide-slate-100 text-sm">
            {(health?.governance.biometricConnectors ?? []).map((conn) => (
              <div key={conn.vendor} className="flex items-center justify-between py-2.5">
                <span className="font-medium text-slate-800">
                  {VENDOR_LABELS[conn.vendor] ?? conn.vendor}
                </span>
                <span className="rounded-md bg-slate-100 px-2.5 py-0.5 font-mono text-[11px] font-medium text-slate-600">
                  {conn.maturity}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
