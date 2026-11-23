'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Building2,
  FileCheck2,
  IdCard,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MapPin,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { api, type HealthResponse } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { loading, needsInitialSetup, me, switchTenant, signOut, hasPermission } = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [switching, setSwitching] = useState(false);

  const mustCompleteMfaSetup = Boolean(
    me && (me.user.mfaSetupRequired || (me.user.mfaRequired && !me.user.mfaVerified)),
  );

  useEffect(() => {
    if (loading) return;
    if (needsInitialSetup) {
      router.replace('/setup');
    } else if (!me) {
      router.replace('/login');
    } else if (mustCompleteMfaSetup && pathname !== '/dashboard/security') {
      router.replace('/dashboard/security');
    }
  }, [loading, needsInitialSetup, me, mustCompleteMfaSetup, pathname, router]);

  useEffect(() => {
    if (!me) return;
    void api
      .get<HealthResponse>('/health')
      .then(setHealth)
      .catch(() => null);
  }, [me]);

  if (loading || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-300 border-t-blue-700" />
      </div>
    );
  }

  const navItems = [
    {
      href: '/dashboard',
      label: 'Vue d’ensemble',
      icon: LayoutDashboard,
      visible: true,
    },
    {
      href: '/dashboard/tenants',
      label: 'Entreprises (SaaS)',
      icon: Building2,
      visible: me.user.isPlatformSuperadmin,
    },
    {
      href: '/dashboard/employees',
      label: 'Dossiers Employés RDC',
      icon: IdCard,
      visible: Boolean(me.activeTenant) && hasPermission('employees.read'),
    },
    {
      href: '/dashboard/organization',
      label: 'Sites & Organisation',
      icon: MapPin,
      visible: Boolean(me.activeTenant) && hasPermission('organization.sites.read'),
    },
    {
      href: '/dashboard/access',
      label: 'Rôles, Accès & SoD',
      icon: Users,
      visible:
        Boolean(me.activeTenant) &&
        (hasPermission('rbac.roles.read') || hasPermission('rbac.members.read')),
    },
    {
      href: '/dashboard/audit',
      label: 'Journal d’audit SHA-256',
      icon: FileCheck2,
      visible: me.user.isPlatformSuperadmin || hasPermission('audit.read'),
    },
    {
      href: '/dashboard/security',
      label: 'Sécurité & MFA',
      icon: KeyRound,
      visible: true,
    },
  ].filter(
    (item) => item.visible && (!mustCompleteMfaSetup || item.href === '/dashboard/security'),
  );

  async function handleTenantChange(newTenantId: string) {
    if (!newTenantId || newTenantId === me?.activeTenant?.id) return;
    setSwitching(true);
    try {
      await switchTenant(newTenantId);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Barre latérale institutionnelle */}
      <aside className="flex w-64 shrink-0 flex-col justify-between bg-[#0B1628] text-slate-200">
        <div>
          <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">
              N
            </div>
            <div>
              <p className="text-sm font-bold tracking-tight text-white">NEXUS RH</p>
              <p className="text-[11px] text-slate-400">SaaS RH RDC · v0.2</p>
            </div>
          </div>

          <nav className="space-y-1 p-3">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active =
                item.href === '/dashboard'
                  ? pathname === '/dashboard'
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                    active
                      ? 'bg-blue-600/20 text-white ring-1 ring-blue-500/40'
                      : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                  }`}
                >
                  <Icon className={`h-4 w-4 ${active ? 'text-blue-400' : 'text-slate-400'}`} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="border-t border-slate-800 p-4 text-xs">
          <div className="mb-3 flex items-center justify-between">
            <span className="truncate font-medium text-white">{me.user.fullName}</span>
            {me.user.mfaEnabled ? (
              <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                <ShieldCheck className="h-3 w-3" /> MFA
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                <ShieldAlert className="h-3 w-3" /> MFA off
              </span>
            )}
          </div>
          <p className="mb-3 truncate text-[11px] text-slate-400">{me.user.email}</p>
          <button
            type="button"
            onClick={async () => {
              await signOut();
              router.push('/login');
            }}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-slate-800"
          >
            <LogOut className="h-3.5 w-3.5" />
            Déconnexion sécurisée
          </button>
        </div>
      </aside>

      {/* Zone principale */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barre supérieure avec sélecteur d'entreprise isolé et indicateur transparent d'environnement */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-3.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Entreprise active
            </span>
            {me.accessibleTenants.length > 0 ? (
              <div className="flex items-center gap-2">
                <select
                  value={me.activeTenant?.id ?? ''}
                  disabled={switching}
                  onChange={(e) => void handleTenantChange(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  {!me.activeTenant && <option value="">— Sélectionner une entreprise —</option>}
                  {me.accessibleTenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.legalName} ({t.defaultCurrency}){t.isDemoTenant ? ' [DÉMO/TEST]' : ''}
                    </option>
                  ))}
                </select>
                {me.activeTenant?.isDemoTenant && (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                    TENANT DÉMO / TEST
                  </span>
                )}
              </div>
            ) : (
              <span className="text-sm text-slate-500">
                Aucune entreprise enregistrée
                {me.user.isPlatformSuperadmin && (
                  <>
                    {' — '}
                    <Link
                      href="/dashboard/tenants"
                      className="font-medium text-blue-700 hover:underline"
                    >
                      Créer une entreprise
                    </Link>
                  </>
                )}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 text-xs">
            <span className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 font-medium text-slate-700">
              Rôle : {me.roles.join(', ') || 'Utilisateur'}
            </span>
            {health && health.infraProfile !== 'production' && (
              <span
                title="Indication transparente du profil d'infrastructure actif"
                className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 font-mono text-[11px] font-medium text-amber-800"
              >
                INFRA : {health.infraProfile.toUpperCase()}
              </span>
            )}
          </div>
        </header>

        {/* Confinement obligatoire MFA pour les rôles à privilèges (C-03 / N-04) */}
        {mustCompleteMfaSetup && (
          <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-xs text-amber-900">
            <span className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600" />
              Authentification multi-facteurs (MFA TOTP) obligatoire pour votre rôle actif : veuillez
              finaliser l’enrôlement TOTP pour déverrouiller les modules métier.
            </span>
            {pathname !== '/dashboard/security' && (
              <Link
                href="/dashboard/security"
                className="font-semibold text-amber-900 underline hover:text-amber-700"
              >
                Configurer la MFA maintenant
              </Link>
            )}
          </div>
        )}

        <main className="flex-1 p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
