// API de auth de punta a punta (Fastify inject) contra Postgres real. Rate limit en memoria.
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { createAuthService } from '../../src/features/auth';
import { createDb, type Db } from '../../src/lib/db';

const url = process.env.TEST_DATABASE_URL ?? '';
const ORIGIN = 'http://localhost:5173';

describe.skipIf(!url)('API /auth de punta a punta', () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createDb(url);
  });
  beforeEach(async () => {
    await db.session.deleteMany();
    await db.user.deleteMany();
    // App nueva por test: el rate limit en memoria arranca de cero.
    app = await buildApp({ auth: { service: createAuthService(db), cookieSecure: false } });
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'sid');
  const post = (path: string, payload: unknown, headers: Record<string, string> = { origin: ORIGIN }, cookie?: string) =>
    app.inject({ method: 'POST', url: path, payload: payload as object, headers: { ...headers, ...(cookie ? { cookie: `sid=${cookie}` } : {}) } });
  const me = (cookie?: string) => app.inject({ method: 'GET', url: '/auth/me', headers: cookie ? { cookie: `sid=${cookie}` } : {} });

  it('registro → me → logout → me 401 → login → me', async () => {
    const reg = await post('/auth/register', { email: 'Ana@Ejemplo.com', password: 'clave-larga-1', name: 'Ana' });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({ user: { email: 'ana@ejemplo.com', name: 'Ana' } });
    const cookie = sid(reg);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.secure).toBeFalsy();

    expect((await me(cookie?.value)).json()).toMatchObject({ user: { email: 'ana@ejemplo.com' } });

    const out = await post('/auth/logout', {}, { origin: ORIGIN }, cookie?.value);
    expect(out.statusCode).toBe(204);
    expect(await db.session.count()).toBe(0);
    expect((await me(cookie?.value)).statusCode).toBe(401);
    expect((await me()).json()).toEqual({ error: 'unauthenticated', message: 'Hay que iniciar sesión' });

    const login = await post('/auth/login', { email: 'ana@ejemplo.com', password: 'clave-larga-1' });
    expect(login.statusCode).toBe(200);
    expect((await me(sid(login)?.value)).statusCode).toBe(200);
  });

  it('errores con forma { error, message }: duplicado 409, contraseña débil 400, credenciales 401', async () => {
    await post('/auth/register', { email: 'a@b.cd', password: 'clave-larga-1' });
    expect((await post('/auth/register', { email: 'A@B.CD', password: 'clave-larga-1' })).json()).toMatchObject({ error: 'email_taken' });
    const weak = await post('/auth/register', { email: 'x@y.zz', password: 'corta' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({ error: 'weak_password' });
    const bad = await post('/auth/login', { email: 'a@b.cd', password: 'otra-clave-99' });
    const ghost = await post('/auth/login', { email: 'nadie@b.cd', password: 'otra-clave-99' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual(ghost.json());
  });

  it('el login rota la sesión: el token anterior deja de valer', async () => {
    const first = sid(await post('/auth/register', { email: 'a@b.cd', password: 'clave-larga-1' }))?.value;
    const second = sid(await post('/auth/login', { email: 'a@b.cd', password: 'clave-larga-1' }, { origin: ORIGIN }, first))?.value;
    expect(second).not.toBe(first);
    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(200);
  });

  it('CSRF: un POST con la cookie de sesión y sin Origin, o con Origin ajeno, da 403', async () => {
    const cookie = sid(await post('/auth/register', { email: 'a@b.cd', password: 'clave-larga-1' }))?.value;
    const noOrigin = await post('/auth/logout', {}, {}, cookie);
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json()).toMatchObject({ error: 'forbidden_origin' });
    expect((await post('/auth/logout', {}, { origin: 'http://evil.com' }, cookie)).statusCode).toBe(403);
    expect((await me(cookie)).statusCode).toBe(200); // la sesión sigue viva
    // Sin cookie (cliente que no es navegador) no aplica.
    expect((await post('/auth/login', { email: 'a@b.cd', password: 'clave-larga-1' }, {})).statusCode).toBe(200);
  });

  it('rate limit: el intento número 11 en 15 minutos da 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post('/auth/login', { email: 'x@y.zz', password: 'clave-larga-1' })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    const last = await post('/auth/login', { email: 'x@y.zz', password: 'clave-larga-1' });
    expect(last.statusCode).toBe(429);
    expect(last.json()).toMatchObject({ error: 'rate_limited' });
  });
});
