// Cuentas y sesiones. Ver docs/specs/auth.md.
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../lib/db';
import { getDummyHash, hashPassword, isValidPassword, normalizeEmail, verifyPassword } from './passwords';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_MAX = 100;

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

export type AuthErrorCode = 'invalid_email' | 'weak_password' | 'invalid_name' | 'email_taken' | 'invalid_credentials';

export class AuthError extends Error {
  override name = 'AuthError';
  constructor(readonly code: AuthErrorCode, message: string) {
    super(message);
  }
}

export interface SessionResult {
  user: PublicUser;
  /** Token para la cookie. Solo existe aquí: en la base se guarda su sha256. */
  token: string;
  expiresAt: Date;
}

export interface AuthService {
  register(input: { email: unknown; password: unknown; name?: unknown }): Promise<SessionResult>;
  login(input: { email: unknown; password: unknown }): Promise<SessionResult>;
  /** Usuario de una sesión válida, o null (token desconocido o vencido). */
  getUserBySessionToken(token: string): Promise<PublicUser | null>;
  logout(token: string): Promise<void>;
  sweepExpiredSessions(): Promise<number>;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createAuthService(db: Db, options: { now?: () => Date; sessionTtlMs?: number } = {}): AuthService {
  const now = options.now ?? (() => new Date());
  const ttl = options.sessionTtlMs ?? SESSION_TTL_MS;

  async function startSession(user: { id: string; email: string; name: string | null; createdAt: Date }): Promise<SessionResult> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now().getTime() + ttl);
    await db.session.create({ data: { id: hashToken(token), userId: user.id, expiresAt } });
    return { user: toPublic(user), token, expiresAt };
  }

  return {
    async register({ email, password, name }) {
      const normalized = normalizeEmail(email);
      if (!normalized) throw new AuthError('invalid_email', 'Email inválido');
      if (!isValidPassword(password)) {
        throw new AuthError('weak_password', 'La contraseña debe tener entre 10 y 256 caracteres');
      }
      let cleanName: string | null = null;
      if (name !== undefined && name !== null && name !== '') {
        if (typeof name !== 'string' || name.trim().length === 0 || name.length > NAME_MAX) {
          throw new AuthError('invalid_name', `El nombre debe tener entre 1 y ${NAME_MAX} caracteres`);
        }
        cleanName = name.trim();
      }
      const passwordHash = await hashPassword(password);
      try {
        const user = await db.user.create({ data: { email: normalized, name: cleanName, passwordHash } });
        return await startSession(user);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AuthError('email_taken', 'Ya existe una cuenta con ese email');
        throw error;
      }
    },

    async login({ email, password }) {
      const normalized = normalizeEmail(email);
      const user = normalized ? await db.user.findUnique({ where: { email: normalized } }) : null;
      // Siempre se verifica un hash, exista o no el usuario: el tiempo no revela qué cuentas existen.
      const ok = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), typeof password === 'string' ? password : '');
      if (!user || !ok || !isValidPassword(password)) {
        throw new AuthError('invalid_credentials', 'Email o contraseña incorrectos');
      }
      return startSession(user);
    },

    async getUserBySessionToken(token) {
      if (!token) return null;
      const session = await db.session.findUnique({ where: { id: hashToken(token) }, include: { user: true } });
      if (!session) return null;
      if (session.expiresAt <= now()) {
        await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
        return null;
      }
      return toPublic(session.user);
    },

    async logout(token) {
      if (!token) return;
      await db.session.deleteMany({ where: { id: hashToken(token) } });
    },

    async sweepExpiredSessions() {
      const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: now() } } });
      return count;
    },
  };
}

function toPublic(user: { id: string; email: string; name: string | null; createdAt: Date }): PublicUser {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt.toISOString() };
}

/** Violación de unicidad de Prisma (P2002): el email ya existe. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}
