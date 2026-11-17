// Contraseñas y emails: validación, normalización y hash. Ver docs/specs/auth.md.
import { hash, verify } from '@node-rs/argon2';

export const PASSWORD_MIN = 10;
/** Máximo: argon2 es caro y no tiene sentido hashear entradas enormes. */
export const PASSWORD_MAX = 256;
export const EMAIL_MAX = 254;

/** Algoritmo argon2id (`algorithm: 2`), con los parámetros por defecto de @node-rs/argon2. */
const ARGON2ID = 2;

export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: ARGON2ID });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Un hash corrupto o en otro formato nunca autentica.
    return false;
  }
}

/** Hash de una contraseña que nadie conoce: para gastar el mismo tiempo cuando el email no existe. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(`no-existe-${Math.random()}-${Date.now()}`);
  return dummyHash;
}

export function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

/** Email en minúsculas y sin espacios alrededor; null si no tiene forma de email. */
export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const value = email.trim().toLowerCase();
  if (value.length === 0 || value.length > EMAIL_MAX) return null;
  // Validación deliberadamente simple: algo@algo.algo, sin espacios ni caracteres de control.
  if (!/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(value)) return null;
  return value;
}
