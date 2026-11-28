import { PRIVACY_NOTICE } from '@latexweb/shared';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb } from '../src/db';
import { createAuthService, type SessionResult } from '../src/features/auth/service';
import type { InvitationMessage } from '../src/features/sharing/email';
import { mutationAudit, shareLinks } from '../src/schema';
import { fakeQueue, LIMITS, ORIGIN, resetDb, testDb, testStorage } from './helpers';

const db = testDb();
const storage = testStorage();
const auth = createAuthService(db);
let app: FastifyInstance;
let owner: SessionResult;
let projectId: string;
let messages: InvitationMessage[];
let failMail: boolean;
const request = async (session: SessionResult, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => {
  await auth.acceptPrivacy(session.user.id, { accepted: true, version: PRIVACY_NOTICE.version });
  return app.inject({ method, url, headers: { cookie: `sid=${session.token}`, origin: ORIGIN }, ...(payload ? { payload } : {}) });
};
const invited = () => `/api/projects/${projectId}/invitations`;
const sharePath = () => `/api/share/${new URL(messages.at(-1)!.url).pathname.split('/').at(-1)!}`;
async function invite(email = 'guest@gmail.com') {
  const response = await request(owner, 'POST', invited(), { email, role: 'editor' });
  expect(response.statusCode).toBe(201);
  expect(response.json().link).not.toHaveProperty('token');
  const token = new URL(messages.at(-1)!.url).pathname.split('/').at(-1)!;
  expect(JSON.stringify(await db.select().from(mutationAudit))).not.toContain(token);
  return response.json().link as { id: string; recipientEmail: string };
}
beforeEach(async () => {
  await resetDb(db);
  messages = []; failMail = false;
  app = await buildApp({ auth: { service: auth, cookieSecure: false },
    projects: { db, storage, limits: LIMITS, queue: fakeQueue(), compile: { maxQueued: 5, ttlSeconds: 3600 },
      invitations: { publicUrl: 'https://pliego.duckdns.org', async send(message) {
        if (failMail) throw new Error('SMTP secret that must not leak');
        messages.push(message);
      } },
    } });
  owner = await auth.register({ email: 'owner@example.com', password: 'clave-larga-1' });
  const result = await request(owner, 'POST', '/api/projects', { name: 'Documento privado' });
  projectId = result.json().project.id as string;
});
afterEach(async () => { await app.close(); });
afterAll(async () => { await closeDb(db); storage.close(); });

describe('invitaciones vinculadas al correo', () => {
  it('rechaza enlace reenviado y correo sin verificar; acepta con Google desde otra sesión una sola vez', async () => {
    const link = await invite('Guest@Gmail.com');
    expect(link.recipientEmail).toBe('guest@gmail.com');
    const path = sharePath();
    const stranger = await auth.loginWithGoogle({ subject: 'other-google', email: 'other@gmail.com' });
    for (const method of ['GET', 'POST'] as const) {
      const res = await request(stranger, method, method === 'GET' ? path : `${path}/join`, { email: 'guest@gmail.com' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'invitation_email_mismatch' });
      expect(res.body).not.toContain('Documento privado');
    }
    const local = await auth.register({ email: 'guest@gmail.com', password: 'clave-larga-1' });
    expect((await request(local, 'GET', path)).json()).toMatchObject({ error: 'google_verification_required' });
    expect((await request(local, 'POST', `${path}/join`)).statusCode).toBe(403);
    await auth.loginWithGoogle({ subject: 'guest-google', email: 'guest@gmail.com' }, local.user.id);
    const anotherBrowser = await auth.loginWithGoogle({ subject: 'guest-google', email: 'guest@gmail.com' });
    expect(anotherBrowser.user.id).toBe(local.user.id);
    expect((await request(anotherBrowser, 'GET', path)).json()).toMatchObject({ preview: { projectName: 'Documento privado', role: 'editor' } });
    const concurrent = await Promise.all([request(anotherBrowser, 'POST', `${path}/join`), request(local, 'POST', `${path}/join`)]);
    expect(concurrent.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    expect((await request(owner, 'GET', `/api/projects/${projectId}/share-links`)).json()).toEqual({ links: [] });
    await request(owner, 'DELETE', `/api/projects/${projectId}/members/${local.user.id}`);
    expect((await request(local, 'POST', `${path}/join`)).statusCode).toBe(404);
    expect((await request(local, 'GET', `/api/projects/${projectId}`)).statusCode).toBe(404);
  });

  it('respeta revocación, vencimiento y propiedad; falla el correo sin dejar invitación utilizable', async () => {
    const guest = await auth.loginWithGoogle({ subject: 'guest', email: 'guest@gmail.com' });
    const link = await invite();
    const path = sharePath();
    expect((await request(guest, 'POST', invited(), { email: 'other@gmail.com', role: 'editor' })).statusCode).toBe(404);
    await request(owner, 'DELETE', `/api/projects/${projectId}/share-links/${link.id}`);
    expect((await request(guest, 'POST', `${path}/join`)).statusCode).toBe(404);
    const expiring = await invite();
    await db.update(shareLinks).set({ expiresAt: new Date(0) }).where(eq(shareLinks.id, expiring.id));
    expect((await request(guest, 'GET', sharePath())).statusCode).toBe(404);
    failMail = true;
    const failed = await request(owner, 'POST', invited(), { email: 'guest@gmail.com', role: 'viewer' });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: 'email_delivery_failed' });
    expect(failed.body).not.toContain('SMTP secret');
    expect((await request(owner, 'GET', `/api/projects/${projectId}/share-links`)).json()).toEqual({ links: [] });
    expect((await request(owner, 'POST', invited(), { email: 'guest@gmail.com\r\nBcc: other@gmail.com', role: 'viewer' })).statusCode).toBe(400);
  });

  it('limita envíos por dueño y no permite que un miembro invite', async () => {
    const editor = await auth.loginWithGoogle({ subject: 'editor', email: 'guest@gmail.com' });
    await invite();
    await request(editor, 'POST', `${sharePath()}/join`);
    expect((await request(editor, 'POST', invited(), { email: 'another@gmail.com', role: 'viewer' })).statusCode).toBe(403);
    for (let i = 0; i < 9; i++) await invite(`guest${i}@gmail.com`);
    expect((await request(owner, 'POST', invited(), { email: 'limit@gmail.com', role: 'viewer' })).statusCode).toBe(429);
    expect(messages).toHaveLength(10);
  });
});
