// Servicio de cuentas y sesiones contra Postgres real (base latexweb_test, ver global-setup.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, createAuthService, hashToken, type AuthService } from '../../src/features/auth/service';
import { createDb, type Db } from '../../src/lib/db';

const url = process.env.TEST_DATABASE_URL ?? '';

describe.skipIf(!url)('servicio de auth con Postgres real', () => {
  let db: Db;
  let auth: AuthService;
  let clock = new Date('2026-01-01T00:00:00Z');

  beforeAll(() => {
    db = createDb(url);
    auth = createAuthService(db, { now: () => clock });
  });
  beforeEach(async () => {
    clock = new Date('2026-01-01T00:00:00Z');
    await db.session.deleteMany();
    await db.user.deleteMany();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('registra con email normalizado, hash argon2id y una sesión cuyo id es el sha256 del token', async () => {
    const result = await auth.register({ email: ' Ana@Ejemplo.com ', password: 'clave-larga-1', name: ' Ana ' });
    expect(result.user).toMatchObject({ email: 'ana@ejemplo.com', name: 'Ana' });
    const stored = await db.user.findUniqueOrThrow({ where: { email: 'ana@ejemplo.com' } });
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
    const sessions = await db.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(hashToken(result.token));
    expect(sessions[0]?.id).not.toBe(result.token);
  });

  it('rechaza email duplicado (sin distinguir mayúsculas), email inválido y contraseña débil', async () => {
    await auth.register({ email: 'ana@ejemplo.com', password: 'clave-larga-1' });
    await expect(auth.register({ email: 'ANA@ejemplo.com', password: 'clave-larga-2' })).rejects.toMatchObject({ code: 'email_taken' });
    await expect(auth.register({ email: 'no-email', password: 'clave-larga-1' })).rejects.toMatchObject({ code: 'invalid_email' });
    await expect(auth.register({ email: 'b@c.de', password: 'corta' })).rejects.toMatchObject({ code: 'weak_password' });
  });

  it('login correcto crea una sesión nueva; email inexistente y clave incorrecta dan el mismo error', async () => {
    const reg = await auth.register({ email: 'ana@ejemplo.com', password: 'clave-larga-1' });
    const login = await auth.login({ email: 'ANA@ejemplo.com', password: 'clave-larga-1' });
    expect(login.token).not.toBe(reg.token);
    expect(login.user.email).toBe('ana@ejemplo.com');

    const wrong = await auth.login({ email: 'ana@ejemplo.com', password: 'clave-mala-123' }).catch((e: unknown) => e);
    const missing = await auth.login({ email: 'nadie@ejemplo.com', password: 'clave-larga-1' }).catch((e: unknown) => e);
    for (const error of [wrong, missing]) {
      expect(error).toBeInstanceOf(AuthError);
      expect(error).toMatchObject({ code: 'invalid_credentials', message: 'Email o contraseña incorrectos' });
    }
  });

  it('una sesión vale hasta su vencimiento; vencida da null y se borra; logout la borra', async () => {
    const { token } = await auth.register({ email: 'ana@ejemplo.com', password: 'clave-larga-1' });
    expect(await auth.getUserBySessionToken(token)).toMatchObject({ email: 'ana@ejemplo.com' });
    expect(await auth.getUserBySessionToken('token-inventado')).toBeNull();

    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(await auth.getUserBySessionToken(token)).toBeNull();
    expect(await db.session.count()).toBe(0);

    clock = new Date('2026-01-01T00:00:00Z');
    const again = await auth.login({ email: 'ana@ejemplo.com', password: 'clave-larga-1' });
    await auth.logout(again.token);
    expect(await auth.getUserBySessionToken(again.token)).toBeNull();
  });

  it('el barrido borra solo las sesiones vencidas', async () => {
    await auth.register({ email: 'ana@ejemplo.com', password: 'clave-larga-1' });
    clock = new Date(clock.getTime() + 20 * 24 * 60 * 60 * 1000);
    await auth.login({ email: 'ana@ejemplo.com', password: 'clave-larga-1' });
    clock = new Date(clock.getTime() + 15 * 24 * 60 * 60 * 1000); // la primera venció, la segunda no
    expect(await auth.sweepExpiredSessions()).toBe(1);
    expect(await db.session.count()).toBe(1);
  });
});
