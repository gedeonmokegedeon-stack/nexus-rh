/**
 * Client API typé de NEXUS RH.
 * - Utilise exclusivement des URLs relatives (/api/v1/...) — aucun appel localhost côté navigateur.
 * - Conserve le jeton d'accès JWT UNIQUEMENT en mémoire vive (jamais dans localStorage)
 *   et s'appuie sur le cookie HttpOnly rotatif `nexus_rt` pour la continuité de session.
 */

let inMemoryAccessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const CSRF_HEADER_NAME = 'X-Nexus-CSRF';
const CSRF_HEADER_VALUE = '1';
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function rawRequest<T>(
  path: string,
  options: RequestInit = {},
  allowAutoRefresh: boolean = true,
): Promise<T> {
  const headers = new Headers(options.headers ?? {});
  const method = (options.method ?? 'GET').toUpperCase();
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!SAFE_HTTP_METHODS.has(method) && !headers.has(CSRF_HEADER_NAME)) {
    headers.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
  }
  if (inMemoryAccessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemoryAccessToken}`);
  }

  const res = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });

  if (res.status === 401 && allowAutoRefresh && !path.startsWith('/auth/')) {
    const refreshed = await trySilentRefresh();
    if (refreshed) {
      return rawRequest<T>(path, options, false);
    }
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data.code === 'string' ? data.code : 'HTTP_ERROR',
      typeof data.message === 'string' ? data.message : 'La requête a échoué.',
      Array.isArray(data.details)
        ? (data.details as Array<{ field: string; message: string }>)
        : undefined,
    );
  }

  return data as T;
}

export async function trySilentRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) {
      inMemoryAccessToken = null;
      return false;
    }
    const data = (await res.json()) as { accessToken?: string };
    if (data.accessToken) {
      inMemoryAccessToken = data.accessToken;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const api = {
  get: <T>(path: string) => rawRequest<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    rawRequest<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    rawRequest<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  del: <T>(path: string, body?: unknown) =>
    rawRequest<T>(path, {
      method: 'DELETE',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
};

// Types des réponses API Mission 1
export interface HealthResponse {
  service: string;
  version: string;
  mission: string;
  status: 'healthy' | 'degraded';
  infraProfile: 'production' | 'docker' | 'sandbox';
  timestamp: string;
  components: {
    database: {
      adapter: string;
      ok: boolean;
      pgVersion: string;
      forceRlsTablesCount: number;
      isSandboxFallback: boolean;
    };
    cache: { adapter: string; ok: boolean; isSandboxFallback: boolean; detail?: string };
    messageBus: { adapter: string; ok: boolean; isSandboxFallback: boolean; detail?: string };
    objectStorage: { adapter: string; ok: boolean; isSandboxFallback: boolean; detail?: string };
  };
  governance: {
    defaultBiometricStoragePolicy: 'DEVICE_ONLY';
    hardcodedPayrollRates: boolean;
    biometricConnectors: Array<{
      vendor: string;
      maturity: string;
      operationalOnRealHardware: boolean;
    }>;
  };
}

export interface TenantSummary {
  id: string;
  slug: string;
  legalName: string;
  tradeName: string | null;
  legalForm?: string;
  sectorCode?: string;
  rccm?: string | null;
  idNat?: string | null;
  taxIdDgi?: string | null;
  cnssEmployerNumber?: string | null;
  inppEmployerNumber?: string | null;
  onemEmployerNumber?: string | null;
  matriculePattern?: string;
  status: string;
  defaultCurrency: string;
  biometricStoragePolicy: 'DEVICE_ONLY' | 'ENCRYPTED_CENTRAL_SYNC';
  centralTemplateStorageEnabled?: boolean;
  biometricLegalAuthorizationRef?: string | null;
  isDemoTenant: boolean;
  createdAt?: string;
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    fullName: string;
    isPlatformSuperadmin: boolean;
    mfaEnabled: boolean;
    mfaRequired: boolean;
    mfaVerified: boolean;
    mfaSetupRequired?: boolean;
  };
  sessionId: string;
  activeTenant: TenantSummary | null;
  accessibleTenants: TenantSummary[];
  roles: string[];
  permissions: string[];
  siteAccess: {
    allSites: boolean;
    allowedSiteIds: string[];
  };
}
