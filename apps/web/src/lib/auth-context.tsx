'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  api,
  getAccessToken,
  setAccessToken,
  trySilentRefresh,
  type MeResponse,
} from './api-client';

interface AuthContextValue {
  readonly loading: boolean;
  readonly needsInitialSetup: boolean;
  readonly me: MeResponse | null;
  readonly refreshProfile: () => Promise<MeResponse | null>;
  readonly applyAccessToken: (token: string) => Promise<MeResponse | null>;
  readonly switchTenant: (tenantId: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [needsInitialSetup, setNeedsInitialSetup] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);

  const refreshProfile = useCallback(async (): Promise<MeResponse | null> => {
    try {
      const status = await api.get<{ needsInitialSetup: boolean }>('/auth/bootstrap-status');
      setNeedsInitialSetup(status.needsInitialSetup);
      if (status.needsInitialSetup) {
        setMe(null);
        return null;
      }

      if (!getAccessToken()) {
        const ok = await trySilentRefresh();
        if (!ok) {
          setMe(null);
          return null;
        }
      }

      const profile = await api.get<MeResponse>('/auth/me');
      setMe(profile);
      return profile;
    } catch {
      setAccessToken(null);
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  const applyAccessToken = useCallback(async (token: string): Promise<MeResponse | null> => {
    setAccessToken(token);
    setNeedsInitialSetup(false);
    const profile = await api.get<MeResponse>('/auth/me');
    setMe(profile);
    return profile;
  }, []);

  const switchTenant = useCallback(async (tenantId: string): Promise<void> => {
    const res = await api.post<{ accessToken: string }>('/auth/switch-tenant', { tenantId });
    setAccessToken(res.accessToken);
    const profile = await api.get<MeResponse>('/auth/me');
    setMe(profile);
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Ignorer si la session était déjà expirée
    } finally {
      setAccessToken(null);
      setMe(null);
    }
  }, []);

  const hasPermission = useCallback(
    (permission: string): boolean => {
      if (!me) return false;
      return me.permissions.includes(permission);
    },
    [me],
  );

  return (
    <AuthContext.Provider
      value={{
        loading,
        needsInitialSetup,
        me,
        refreshProfile,
        applyAccessToken,
        switchTenant,
        signOut,
        hasPermission,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth doit être utilisé dans AuthProvider.');
  }
  return ctx;
}
