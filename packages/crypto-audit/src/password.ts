import crypto from 'node:crypto';
import argon2 from 'argon2';

/**
 * Paramètres Argon2id conformes aux recommandations OWASP et à SECURITY_POLICY.md :
 * - Algorithme : Argon2id (résistant GPU/ASIC et attaques par canal auxiliaire)
 * - Mémoire : 64 MiB (65 536 KiB)
 * - Itérations : 3
 * - Parallélisme : 1
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
};

/**
 * Erreur typée émise lorsque la file d'attente bornée Argon2id est saturée (D-05).
 * Permet à l'API de répondre proprement en 503 sans épuisement mémoire (OOM).
 */
export class PasswordHasherOverloadedError extends Error {
  readonly code = 'AUTH_HASHER_OVERLOADED';

  constructor(message = 'Service de vérification cryptographique momentanément saturé. Réessayez.') {
    super(message);
    this.name = 'PasswordHasherOverloadedError';
  }
}

/**
 * Sémaphore asynchrone borné limitant la concurrence simultanée des opérations Argon2id (64 MiB/op).
 * Par défaut : 4 opérations simultanées maximum (plafond natif ~256 MiB) et file bornée à 64.
 */
export class BoundedConcurrencyLimiter {
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(
    readonly maxConcurrent: number,
    readonly maxQueue: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent doit être un entier >= 1.');
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new Error('maxQueue doit être un entier >= 0.');
    }
  }

  get inFlight(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.waitQueue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrent) {
      if (this.waitQueue.length >= this.maxQueue) {
        throw new PasswordHasherOverloadedError();
      }
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    this.activeCount += 1;
    try {
      return await task();
    } finally {
      this.activeCount -= 1;
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    }
  }
}

function resolveDefaultArgon2Concurrency(): number {
  const raw = Number(process.env.ARGON2_MAX_CONCURRENCY ?? 4);
  if (!Number.isFinite(raw)) return 4;
  return Math.min(16, Math.max(1, Math.floor(raw)));
}

function resolveDefaultArgon2MaxQueue(): number {
  const raw = Number(process.env.ARGON2_MAX_QUEUE ?? 64);
  if (!Number.isFinite(raw)) return 64;
  return Math.min(256, Math.max(4, Math.floor(raw)));
}

const defaultArgon2Limiter = new BoundedConcurrencyLimiter(
  resolveDefaultArgon2Concurrency(),
  resolveDefaultArgon2MaxQueue(),
);

let dummyPasswordHashPromise: Promise<string> | null = null;

function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    const unreachableSecret = crypto.randomBytes(32).toString('hex');
    dummyPasswordHashPromise = defaultArgon2Limiter
      .run(() => argon2.hash(unreachableSecret, ARGON2_OPTIONS))
      .catch((err) => {
        dummyPasswordHashPromise = null;
        throw err;
      });
  }
  return dummyPasswordHashPromise;
}

const TRIVIAL_PINS = new Set([
  '000000',
  '111111',
  '222222',
  '333333',
  '444444',
  '555555',
  '666666',
  '777777',
  '888888',
  '999999',
  '123456',
  '654321',
  '123123',
  '112233',
  '121212',
  '012345',
  '543210',
  '234567',
  '345678',
  '456789',
]);

export async function hashPassword(plainPassword: string): Promise<string> {
  if (plainPassword.length < 12 || plainPassword.length > 128) {
    throw new Error('Le mot de passe doit contenir entre 12 et 128 caractères.');
  }
  return defaultArgon2Limiter.run(() => argon2.hash(plainPassword, ARGON2_OPTIONS));
}

export async function verifyPassword(hash: string, candidate: string): Promise<boolean> {
  if (!hash || !candidate || candidate.length > 128) {
    return false;
  }
  return defaultArgon2Limiter.run(async () => {
    try {
      return await argon2.verify(hash, candidate);
    } catch {
      return false;
    }
  });
}

/**
 * Exécute une vérification Argon2id réelle (64 MiB, t=3, p=1) sur un condensat factice
 * afin de neutraliser l'oracle temporel d'énumération des comptes inconnus, désactivés
 * ou verrouillés lors de l'authentification (D-03), tout en respectant le sémaphore D-05.
 */
export async function performDummyPasswordVerify(candidate: string): Promise<void> {
  const normalized = candidate && candidate.length <= 128 ? candidate : 'nexus-dummy-candidate';
  const dummyHash = await getDummyPasswordHash();
  await defaultArgon2Limiter.run(async () => {
    try {
      await argon2.verify(dummyHash, normalized);
    } catch {
      // Résultat ignoré : seul le coût temporel et mémoire homogène compte.
    }
  });
}

export function assertStrongPin(pin: string, forbiddenSubstrings: string[] = []): void {
  if (!/^\d{6}$/.test(pin)) {
    throw new Error('Le code PIN doit contenir exactement 6 chiffres.');
  }
  if (TRIVIAL_PINS.has(pin)) {
    throw new Error('Ce code PIN est trop prévisible et interdit par la politique de sécurité.');
  }
  for (const forbidden of forbiddenSubstrings) {
    if (forbidden.length >= 4 && pin.includes(forbidden)) {
      throw new Error('Le code PIN ne peut pas contenir une information personnelle évidente.');
    }
  }
}

export async function hashPin(pin: string, forbiddenSubstrings: string[] = []): Promise<string> {
  assertStrongPin(pin, forbiddenSubstrings);
  return defaultArgon2Limiter.run(() => argon2.hash(pin, ARGON2_OPTIONS));
}

export async function verifyPin(hash: string, candidatePin: string): Promise<boolean> {
  if (!/^\d{6}$/.test(candidatePin)) {
    return false;
  }
  return defaultArgon2Limiter.run(async () => {
    try {
      return await argon2.verify(hash, candidatePin);
    } catch {
      return false;
    }
  });
}
