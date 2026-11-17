// Cuentas y sesiones. Ver docs/specs/auth.md.
import { createHash, randomBytes } from 'node:crypto';
import { eq, lte } from 'drizzle-orm';
import { isUniqueViolation, type Db } from '../../db';
import { sessions, users } from '../../schema';
import { getDummyHash, hashPassword, isValidPassword, normalizeEmail, verifyPassword } from './passwords';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_MAX = 100;
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}‪-‮⁦-⁩‎‏]/u;

// Contratos compartidos con la web (shared/src/api/auth.ts).
import type { AuthErrorCode, PublicUser } from '@latexweb/shared';
export type { AuthErrorCode, PublicUser };

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
    await db.insert(sessions).values({ id: hashToken(token), userId: user.id, expiresAt });
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
        // Sin caracteres de control (Postgres rechaza NUL → 500) ni de control bidi (suplantación en la UI).
        if (typeof name !== 'string' || name.trim().length === 0 || name.length > NAME_MAX || UNSAFE_NAME_CHARACTERS.test(name)) {
          throw new AuthError('invalid_name', `El nombre debe tener entre 1 y ${NAME_MAX} caracteres`);
        }
        cleanName = name.trim();
      }
      const passwordHash = await hashPassword(password);
      try {
        const [user] = await db.insert(users).values({ email: normalized, name: cleanName, passwordHash }).returning();
        if (!user) throw new Error('el INSERT de users no devolvió la fila');
        return await startSession(user);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AuthError('email_taken', 'Ya existe una cuenta con ese email');
        throw error;
      }
    },

    async login({ email, password }) {
      const normalized = normalizeEmail(email);
      const user = normalized ? await db.query.users.findFirst({ where: eq(users.email, normalized) }) : undefined;
      // Siempre se verifica un hash, exista o no el usuario: el tiempo no revela qué cuentas existen.
      // Una contraseña fuera de rango se reemplaza por '' antes de hashear (nunca se hashea una
      // entrada enorme), y se sigue verificando para mantener el mismo tiempo.
      const candidate = isValidPassword(password) ? password : '';
      const ok = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), candidate);
      if (!user || !ok || candidate === '') {
        throw new AuthError('invalid_credentials', 'Email o contraseña incorrectos');
      }
      return startSession(user);
    },

    async getUserBySessionToken(token) {
      if (!token) return null;
      const [row] = await db
        .select({ user: users, expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.id, hashToken(token)));
      if (!row) return null;
      if (row.expiresAt <= now()) {
        await db.delete(sessions).where(eq(sessions.id, hashToken(token))).catch(() => undefined);
        return null;
      }
      return toPublic(row.user);
    },

    async logout(token) {
      if (!token) return;
      await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
    },

    async sweepExpiredSessions() {
      const deleted = await db.delete(sessions).where(lte(sessions.expiresAt, now())).returning({ id: sessions.id });
      return deleted.length;
    },
  };
}

function toPublic(user: { id: string; email: string; name: string | null; createdAt: Date }): PublicUser {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt.toISOString() };
}

