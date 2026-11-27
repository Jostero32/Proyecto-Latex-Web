import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../src/db';
import { createAuthService } from '../src/features/auth/service';
import { users } from '../src/schema';
import { resetDb, testDb } from './helpers';

const db = testDb();
const auth = createAuthService(db);
beforeEach(() => resetDb(db));
afterAll(() => closeDb(db));

describe('cuentas Google persistidas', () => {
  it('crea y reutiliza por subject, conserva perfil privado y no admite contraseña inventada', async () => {
    const identity = { subject: 'stable-google-id', email: 'ana@gmail.com', name: 'Ana' };
    const first = await auth.loginWithGoogle(identity);
    const second = await auth.loginWithGoogle(identity);
    expect(second.user.id).toBe(first.user.id);
    expect(second.token).not.toBe(first.token);
    expect(first.user).not.toHaveProperty('googleSubject');
    const [row] = await db.select().from(users).where(eq(users.id, first.user.id));
    expect(row).toMatchObject({ passwordHash: null, googleSubject: identity.subject, googleEmail: identity.email });
    await expect(auth.login({ email: identity.email, password: 'clave-inventada' })).rejects.toMatchObject({ code: 'invalid_credentials' });
    await auth.loginWithGoogle({ ...identity, email: 'nuevo@gmail.com' });
    expect((await db.select().from(users).where(eq(users.id, first.user.id)))[0]?.googleEmail).toBe('nuevo@gmail.com');
  });

  it('no fusiona por email: requiere sesión local explícita y coincidencia del correo para vincular', async () => {
    const local = await auth.register({ email: 'ana@gmail.com', password: 'clave-larga-1' });
    const identity = { subject: 'ana-google', email: 'ana@gmail.com' };
    await expect(auth.loginWithGoogle(identity)).rejects.toMatchObject({ code: 'google_link_required' });
    await expect(auth.loginWithGoogle({ ...identity, email: 'otra@gmail.com' }, local.user.id)).rejects.toMatchObject({ code: 'google_account_conflict' });
    const linked = await auth.loginWithGoogle(identity, local.user.id);
    expect(linked.user.id).toBe(local.user.id);
    expect((await auth.login({ email: local.user.email, password: 'clave-larga-1' })).user.id).toBe(local.user.id);
    const other = await auth.register({ email: 'otra@gmail.com', password: 'clave-larga-1' });
    await expect(auth.loginWithGoogle(identity, other.user.id)).rejects.toMatchObject({ code: 'google_account_conflict' });
    await expect(auth.loginWithGoogle({ ...identity, subject: 'replacement-id' }, local.user.id)).rejects.toMatchObject({ code: 'google_account_conflict' });
  });
});
