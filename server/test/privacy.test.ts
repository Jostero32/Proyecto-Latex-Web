import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { PRIVACY_NOTICE } from '@latexweb/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb } from '../src/db';
import { createAuthService, type SessionResult } from '../src/features/auth/service';
import { privacyAcceptances } from '../src/schema';
import { fakeQueue, LIMITS, ORIGIN, resetDb, testDb, testStorage } from './helpers';

const db = testDb();
const storage = testStorage();
const auth = createAuthService(db);
let app: FastifyInstance;
beforeEach(async () => {
  await resetDb(db);
  app = await buildApp({ auth: { service: auth, cookieSecure: false }, projects: {
    db, storage, limits: LIMITS, queue: fakeQueue(), compile: { maxQueued: 5, ttlSeconds: 3600 },
  } });
});
afterEach(() => app.close());
afterAll(async () => { await closeDb(db); storage.close(); });
const request = (session: SessionResult, url: string, payload?: object, origin: string | null = ORIGIN) =>
  app.inject({ method: payload ? 'POST' : 'GET', url, headers: { cookie: `sid=${session.token}`, ...(origin ? { origin } : {}) }, ...(payload ? { payload } : {}) });
const accept = (session: SessionResult, payload: object = { accepted: true, version: PRIVACY_NOTICE.version }) => request(session, '/api/auth/privacy/accept', payload);

async function upgrade(cookie: string): Promise<string> {
  const port = (app.server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write([
      'GET /collab HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', `Origin: ${ORIGIN}`, `Cookie: ${cookie}`, '', '',
    ].join('\r\n')));
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Upgrade no respondió')); });
    socket.on('error', reject);
    socket.on('data', (data: Buffer) => { socket.destroy(); resolve(data.toString().split('\r\n')[0]!); });
  });
}

describe('aceptación expresa y persistente de privacidad', () => {
  it('Google y contraseña tienen el mismo bloqueo: aceptar habilita la API y persiste en otra sesión', async () => {
    const local = await auth.register({ email: 'local@example.com', password: 'clave-larga-1' });
    const google = await auth.loginWithGoogle({ subject: 'privacy-google', email: 'google@gmail.com' });
    expect((await app.inject('/api/auth/privacy')).json()).toEqual(PRIVACY_NOTICE);
    for (const session of [local, google]) {
      expect(session.user.privacy).toBeNull();
      expect((await request(session, '/api/projects')).json()).toMatchObject({ error: 'privacy_acceptance_required' });
      expect((await request(session, '/api/auth/me')).statusCode).toBe(200);
      const result = await accept(session);
      expect(result.statusCode).toBe(200);
      expect(result.json().user.privacy).toMatchObject({ version: PRIVACY_NOTICE.version });
      expect((await request(session, '/api/projects')).statusCode).toBe(200);
      expect((await auth.getUserBySessionToken(session.token))?.privacy?.version).toBe(PRIVACY_NOTICE.version);
    }
    expect((await auth.login({ email: local.user.email, password: 'clave-larga-1' })).user.privacy).not.toBeNull();
    expect((await auth.loginWithGoogle({ subject: 'privacy-google', email: 'google@gmail.com' })).user.privacy).not.toBeNull();
  });

  it('rechaza aceptación implícita, texto true, versión antigua, falta de sesión y CSRF; no registra nada', async () => {
    const session = await auth.register({ email: 'no@example.com', password: 'clave-larga-1' });
    for (const accepted of [false, 'true', 1, null, undefined]) {
      expect((await accept(session, { accepted, version: PRIVACY_NOTICE.version })).statusCode).toBe(400);
    }
    expect((await accept(session, { accepted: true, version: 'old' })).statusCode).toBe(409);
    expect((await request(session, '/api/auth/privacy/accept', { accepted: true, version: PRIVACY_NOTICE.version }, null)).statusCode).toBe(403);
    expect((await request(session, '/api/auth/privacy/accept', { accepted: true, version: PRIVACY_NOTICE.version }, 'https://other.example')).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/privacy/accept', payload: { accepted: true, version: PRIVACY_NOTICE.version }, headers: { origin: ORIGIN } })).statusCode).toBe(401);
    expect(await db.$count(privacyAcceptances)).toBe(0);
    expect((await request(session, '/api/auth/logout', {})).statusCode).toBe(204);
  });

  it('no atribuye aceptación retroactiva; conserva historial y fecha en solicitudes repetidas/concurrentes', async () => {
    const session = await auth.register({ email: 'history@example.com', password: 'clave-larga-1' });
    await db.insert(privacyAcceptances).values({ userId: session.user.id, version: 'old', acceptedAt: new Date(0) });
    expect((await auth.getUserBySessionToken(session.token))?.privacy).toBeNull();
    const results = await Promise.all([accept(session), accept(session)]);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(results[0]!.json().user.privacy.acceptedAt).toBe(results[1]!.json().user.privacy.acceptedAt);
    const repeated = await accept(session, { accepted: true, version: PRIVACY_NOTICE.version, acceptedAt: '1900-01-01', userId: 'another-user' });
    expect(repeated.json().user.privacy.acceptedAt).toBe(results[0]!.json().user.privacy.acceptedAt);
    expect(await db.$count(privacyAcceptances)).toBe(2);
    expect(await db.$count(privacyAcceptances, and(eq(privacyAcceptances.userId, session.user.id), eq(privacyAcceptances.version, PRIVACY_NOTICE.version)))).toBe(1);
  });

  it('tampoco se puede saltar el aviso conectando directamente al WebSocket', async () => {
    const session = await auth.register({ email: 'socket@example.com', password: 'clave-larga-1' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    expect(await upgrade(`sid=${session.token}`)).toContain('403');
    await accept(session);
    expect(await upgrade(`sid=${session.token}`)).toContain('101');
  });
});
