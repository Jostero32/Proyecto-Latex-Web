// Cuentas y sesiones. Ver docs/specs/auth.md.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lte } from 'drizzle-orm';
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

/** Identidad verificada por el proveedor OIDC del servidor; nunca tomada directamente del cliente. */
export interface GoogleIdentity {
  subject: string;
  email: string;
  name?: string;
}

export interface AuthService {
  register(input: { email: unknown; password: unknown; name?: unknown }): Promise<SessionResult>;
  login(input: { email: unknown; password: unknown }): Promise<SessionResult>;
  loginWithGoogle(identity: GoogleIdentity, linkUserId?: string): Promise<SessionResult>;
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
      if (!user || !user.passwordHash || !ok || candidate === '') {
        throw new AuthError('invalid_credentials', 'Email o contraseña incorrectos');
      }
      return startSession(user);
    },

    async loginWithGoogle(identity, linkUserId) {
      const email = normalizeEmail(identity.email);
      if (!email || !/^[\x21-\x7e]{1,255}$/.test(identity.subject)) throw new AuthError('invalid_credentials', 'Identidad de Google inválida');
      let user;
      try {
        user = await db.transaction(async (tx) => {
          const linked = await tx.query.users.findFirst({ where: eq(users.googleSubject, identity.subject) });
          if (linked) {
            if (linkUserId && linked.id !== linkUserId) throw new AuthError('google_account_conflict', 'La cuenta de Google ya está vinculada');
            const [refreshed] = await tx.update(users).set({ googleEmail: email }).where(eq(users.id, linked.id)).returning();
            return refreshed!;
          }
          if (linkUserId) {
            const target = await tx.query.users.findFirst({ where: eq(users.id, linkUserId) });
            if (!target || target.email !== email || target.googleSubject) {
              throw new AuthError('google_account_conflict', 'El email de Google debe coincidir con el de tu cuenta');
            }
            // La actualización condicional evita sustituir otra vinculación concurrente.
            const [updated] = await tx.update(users).set({ googleSubject: identity.subject, googleEmail: email })
              .where(and(eq(users.id, linkUserId), isNull(users.googleSubject))).returning();
            if (!updated) throw new AuthError('google_account_conflict', 'La cuenta ya se vinculó');
            return updated;
          }
          const existing = await tx.query.users.findFirst({ where: eq(users.email, email) });
          if (existing) throw new AuthError('google_link_required', 'Entrá con tu contraseña y vinculá Google desde tu cuenta');
          const name = typeof identity.name === 'string' && !UNSAFE_NAME_CHARACTERS.test(identity.name)
            ? identity.name.trim().slice(0, NAME_MAX) || null : null;
          const [created] = await tx.insert(users).values({ email, name, googleSubject: identity.subject, googleEmail: email }).returning();
          if (!created) throw new Error('no se creó el usuario de Google');
          return created;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new AuthError('google_account_conflict', 'La cuenta cambió; volvé a intentar');
        throw error;
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

