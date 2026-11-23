'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, UserPlus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

interface RoleItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

interface MemberItem {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  roleCode: string;
  roleName: string;
  scopeType: string;
  status: string;
  sites: Array<{ siteId: string; siteCode: string; siteName: string }>;
}

interface SodRule {
  code: string;
  permissionA: string;
  permissionB: string;
  reason: string;
}

interface PermissionCatalogItem {
  code: string;
  module: string;
  description: string;
}

interface SiteOption {
  id: string;
  code: string;
  name: string;
}

export default function AccessControlPage() {
  const { me, hasPermission } = useAuth();
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [permCatalog, setPermCatalog] = useState<PermissionCatalogItem[]>([]);
  const [sodRules, setSodRules] = useState<SodRule[]>([]);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Formulaire rôle personnalisé
  const [showCustomRole, setShowCustomRole] = useState(false);
  const [customRoleCode, setCustomRoleCode] = useState('');
  const [customRoleName, setCustomRoleName] = useState('');
  const [customRolePerms, setCustomRolePerms] = useState<string[]>([]);

  // Formulaire affectation utilisateur
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scopeType, setScopeType] = useState<'ALL_SITES' | 'SELECTED_SITES'>('ALL_SITES');
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);

  const loadAll = useCallback(async () => {
    if (!me?.activeTenant) return;
    setError(null);
    try {
      const [rolesRes, permsRes, membersRes, sitesRes] = await Promise.all([
        api.get<{ roles: RoleItem[] }>('/rbac/roles'),
        api.get<{ permissions: PermissionCatalogItem[]; sodRules: SodRule[] }>('/rbac/permissions'),
        api.get<{ members: MemberItem[] }>('/rbac/members'),
        api.get<{ sites: SiteOption[] }>('/sites'),
      ]);
      setRoles(rolesRes.roles);
      if (!roleId && rolesRes.roles[0]) {
        setRoleId(rolesRes.roles[0].id);
      }
      setPermCatalog(permsRes.permissions);
      setSodRules(permsRes.sodRules);
      setMembers(membersRes.members);
      setSites(sitesRes.sites);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur de chargement RBAC.');
    }
  }, [me?.activeTenant, roleId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.post('/rbac/members', {
        fullName,
        email,
        ...(password ? { password } : {}),
        roleId,
        scopeType,
        siteIds: scopeType === 'SELECTED_SITES' ? selectedSiteIds : [],
      });
      setMessage('Accès attribué avec succès (contrôle SoD validé et journalisé).');
      setFullName('');
      setEmail('');
      setPassword('');
      setSelectedSiteIds([]);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de l’attribution.');
    }
  }

  async function handleRevoke(membershipId: string) {
    if (!window.confirm('Révoquer immédiatement cet accès et couper ses sessions actives ?')) return;
    setError(null);
    try {
      await api.del(`/rbac/members/${membershipId}`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de la révocation.');
    }
  }

  async function handleCreateCustomRole(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.post('/rbac/roles', {
        code: customRoleCode,
        name: customRoleName,
        permissions: customRolePerms,
      });
      setCustomRoleCode('');
      setCustomRoleName('');
      setCustomRolePerms([]);
      setShowCustomRole(false);
      setMessage('Rôle personnalisé créé (contrôle SoD validé et journalisé).');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de création du rôle personnalisé.');
    }
  }

  if (!me?.activeTenant) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-600">
        Sélectionnez d’abord une entreprise active.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Utilisateurs, Rôles (RBAC), Périmètres Sites & Séparation des Tâches (SoD)
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Contrôle d’accès granulaire par établissement et application automatique du principe des
          quatre yeux sur la paie et la biométrie.
        </p>
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

      {/* Formulaire d'attribution */}
      {hasPermission('rbac.members.manage') && (
        <form
          onSubmit={handleAssign}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-2xs"
        >
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-blue-700" />
            <h2 className="text-base font-semibold text-slate-900">
              Attribuer un rôle et un périmètre d’établissement
            </h2>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Nom complet *</label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Courriel *</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Mot de passe initial (si nouveau compte)
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 12 car., Maj, min, chiffre, symbole"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Rôle attribué *</label>
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Périmètre géographique
              </label>
              <select
                value={scopeType}
                onChange={(e) => setScopeType(e.target.value as 'ALL_SITES' | 'SELECTED_SITES')}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="ALL_SITES">Tous les établissements de l’entreprise</option>
                <option value="SELECTED_SITES">Établissements sélectionnés uniquement</option>
              </select>
            </div>
          </div>

          {scopeType === 'SELECTED_SITES' && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
              <p className="mb-2 text-xs font-semibold text-slate-700">
                Cochez les établissements autorisés :
              </p>
              <div className="flex flex-wrap gap-3">
                {sites.map((s) => {
                  const checked = selectedSiteIds.includes(s.id);
                  return (
                    <label key={s.id} className="inline-flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setSelectedSiteIds((prev) =>
                            e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id),
                          );
                        }}
                      />
                      <span className="font-mono font-semibold">{s.code}</span> — {s.name}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
            >
              Valider l’affectation
            </button>
          </div>
        </form>
      )}

      {/* Utilisateurs actifs */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
        <div className="border-b border-slate-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">
            Affectations utilisateurs ({members.length})
          </h2>
        </div>
        {members.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">Aucun membre rattaché pour le moment.</p>
        ) : (
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3">Utilisateur</th>
                <th className="px-5 py-3">Rôle</th>
                <th className="px-5 py-3">Périmètre</th>
                <th className="px-5 py-3">Statut</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((m) => (
                <tr key={m.membershipId}>
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-900">{m.fullName}</p>
                    <p className="text-xs text-slate-500">{m.email}</p>
                  </td>
                  <td className="px-5 py-3">
                    <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-medium text-slate-800">
                      {m.roleCode}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-700">
                    {m.scopeType === 'ALL_SITES'
                      ? 'Tous les sites'
                      : m.sites.map((s) => s.siteCode).join(', ') || m.scopeType}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        m.status === 'ACTIVE'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {m.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    {m.status === 'ACTIVE' && hasPermission('rbac.members.manage') && (
                      <button
                        type="button"
                        onClick={() => void handleRevoke(m.membershipId)}
                        className="inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="h-3 w-3" /> Révoquer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Règles de séparation des tâches & catalogue des rôles */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold text-slate-900">
              Règles actives de Séparation des Tâches (SoD)
            </h2>
          </div>
          <ul className="mt-4 space-y-3 text-xs">
            {sodRules.map((rule) => (
              <li key={rule.code} className="rounded-lg border border-amber-100 bg-amber-50/50 p-3">
                <p className="font-mono font-semibold text-amber-900">
                  {rule.permissionA} ✕ {rule.permissionB}
                </p>
                <p className="mt-1 text-slate-700">{rule.reason}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">
              Rôles disponibles ({roles.length}) · {permCatalog.length} permissions
            </h2>
            {hasPermission('rbac.roles.manage') && (
              <button
                type="button"
                onClick={() => setShowCustomRole((v) => !v)}
                className="text-xs font-semibold text-blue-700 hover:underline"
              >
                {showCustomRole ? 'Fermer' : '+ Rôle personnalisé'}
              </button>
            )}
          </div>

          {showCustomRole && (
            <form
              onSubmit={handleCreateCustomRole}
              className="mt-4 space-y-3 rounded-lg border border-blue-200 bg-blue-50/40 p-3.5 text-xs"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  required
                  value={customRoleCode}
                  onChange={(e) =>
                    setCustomRoleCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
                  }
                  placeholder="CODE_ROLE (ex. SITE_HR_ASSISTANT)"
                  className="rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono"
                />
                <input
                  type="text"
                  required
                  value={customRoleName}
                  onChange={(e) => setCustomRoleName(e.target.value)}
                  placeholder="Libellé du rôle *"
                  className="rounded border border-slate-300 bg-white px-2.5 py-1.5"
                />
              </div>
              <div className="max-h-40 space-y-1.5 overflow-y-auto rounded border border-slate-200 bg-white p-2.5">
                {permCatalog.map((p) => {
                  const checked = customRolePerms.includes(p.code);
                  return (
                    <label key={p.code} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setCustomRolePerms((prev) =>
                            e.target.checked
                              ? [...prev, p.code]
                              : prev.filter((c) => c !== p.code),
                          )
                        }
                        className="mt-0.5"
                      />
                      <span>
                        <code className="font-mono font-semibold text-slate-800">{p.code}</code>
                        <span className="ml-1.5 text-slate-500">{p.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <button
                type="submit"
                disabled={customRolePerms.length === 0}
                className="w-full rounded bg-blue-700 px-3 py-1.5 font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
              >
                Créer le rôle ({customRolePerms.length} permission(s))
              </button>
            </form>
          )}

          <div className="mt-4 max-h-72 space-y-3 overflow-y-auto pr-1 text-xs">
            {roles.map((r) => (
              <div key={r.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-900">
                    {r.name}{' '}
                    <span className="font-mono text-[10px] font-normal text-slate-400">
                      ({r.isSystem ? 'SYSTÈME' : 'ENTREPRISE'})
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">
                    {r.permissions.length} perm.
                  </span>
                </div>
                {r.description && <p className="mt-1 text-slate-600">{r.description}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
