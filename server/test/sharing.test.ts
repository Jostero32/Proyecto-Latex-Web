// Permisos y compartir de punta a punta: la matriz de roles sobre cada tipo de acción, miembros y
// enlaces (unirse, rol más alto, revocar, vencer).
import type { CreatedShareLink, ProjectFile, ProjectSummary } from '@latexweb/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db';
import { shareLinks } from '../src/schema';
import { projectsApp, resetDb, testDb, testStorage, type Client, type ProjectsHarness } from './helpers';

const db = testDb();
const storage = testStorage();
afterAll(async () => {
  await closeDb(db);
  storage.close();
});

let harness: ProjectsHarness;
let owner: Client;
let project: ProjectSummary;

beforeEach(async () => {
  await resetDb(db);
  harness = await projectsApp(db, storage);
  owner = await harness.user('duena@ejemplo.com');
  project = (await owner.post('/api/projects', { name: 'Compartido' })).json<{ project: ProjectSummary }>().project;
});
afterEach(async () => {
  await harness.app.close();
});

async function link(role: 'editor' | 'viewer', extra: object = {}): Promise<CreatedShareLink> {
  const res = await owner.post(`/api/projects/${project.id}/share-links`, { role, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json<{ link: CreatedShareLink }>().link;
}

async function member(email: string, role: 'editor' | 'viewer'): Promise<Client> {
  const client = await harness.user(email);
  const joined = await client.post(`/api/share/${(await link(role)).token}/join`);
  expect(joined.json()).toEqual({ projectId: project.id, role });
  return client;
}

describe('matriz de roles', () => {
  it('lector: ver, exportar; editor: además escribir; dueño: además administrar; ajeno: 404 en todo', async () => {
    const editor = await member('editor@ejemplo.com', 'editor');
    const viewer = await member('lector@ejemplo.com', 'viewer');
    const stranger = await harness.user('ajeno@ejemplo.com');
    const [main] = (await owner.get(`/api/projects/${project.id}/files`)).json<{ files: ProjectFile[] }>().files;
    const p = `/api/projects/${project.id}`;
    const f = `${p}/files/${main?.id}`;

    const actions: [level: 'read' | 'write' | 'manage', run: (c: Client) => ReturnType<Client['get']>][] = [
      ['read', (c) => c.get(p)],
      ['read', (c) => c.get(`${p}/files`)],
      ['read', (c) => c.get(f)],
      ['read', (c) => c.get(`${p}/export`)],
      ['write', (c) => c.put(f, '\\documentclass{article}')],
      ['write', (c) => c.upload(`${p}/files`, { 'nuevo.tex': 'x' })],
      ['write', (c) => c.patch(p, { engine: 'xelatex' })],
      ['write', (c) => c.patch(f, { path: 'main.tex' })],
      ['manage', (c) => c.patch(p, { name: 'Otro nombre' })],
      ['manage', (c) => c.get(`${p}/members`)],
      ['manage', (c) => c.get(`${p}/share-links`)],
      ['manage', (c) => c.post(`${p}/share-links`, { role: 'viewer' })],
    ];
    const allowed = { owner: ['read', 'write', 'manage'], editor: ['read', 'write'], viewer: ['read'], stranger: [] as string[] };
    for (const [name, client] of [['owner', owner], ['editor', editor], ['viewer', viewer], ['stranger', stranger]] as const) {
      for (const [level, run] of actions) {
        const status = (await run(client)).statusCode;
        const expected = allowed[name].includes(level) ? 'ok' : name === 'stranger' ? 404 : 403;
        expect([name, level, status < 300 ? 'ok' : status]).toEqual([name, level, expected]);
      }
    }
    // Borrar el proyecto: solo el dueño.
    expect((await editor.delete(p)).statusCode).toBe(403);
    expect((await stranger.delete(p)).statusCode).toBe(404);
    expect((await owner.delete(p)).statusCode).toBe(204);
  });
});

describe('miembros y enlaces', () => {
  it('el dueño lista, cambia de rol y quita miembros; su propio rol no se toca', async () => {
    const editor = await member('editor@ejemplo.com', 'editor');
    const members = `/api/projects/${project.id}/members`;
    expect((await owner.get(members)).json()).toEqual({
      members: [
        { userId: owner.userId, email: 'duena@ejemplo.com', name: 'duena', role: 'owner' },
        { userId: editor.userId, email: 'editor@ejemplo.com', name: 'editor', role: 'editor' },
      ],
    });
    expect((await owner.patch(`${members}/${editor.userId}`, { role: 'viewer' })).json()).toMatchObject({ member: { role: 'viewer' } });
    expect((await editor.put(`/api/projects/${project.id}/files/x`, 'x')).statusCode).toBe(403);
    expect((await owner.patch(`${members}/${owner.userId}`, { role: 'viewer' })).json()).toMatchObject({ error: 'cannot_change_owner' });
    expect((await owner.patch(`${members}/${editor.userId}`, { role: 'owner' })).statusCode).toBe(400);

    expect((await owner.delete(`${members}/${editor.userId}`)).statusCode).toBe(204);
    expect((await editor.get(`/api/projects/${project.id}`)).statusCode).toBe(404);
  });

  it('ver un enlace antes de unirse: proyecto, dueño y rol, sin unirse', async () => {
    const editorLink = await link('editor');
    const guest = await harness.user('invitada@ejemplo.com');
    const seen = await guest.get(`/api/share/${editorLink.token}`);
    expect(seen.json()).toEqual({
      preview: { projectId: project.id, projectName: project.name, ownerName: 'duena', role: 'editor', currentRole: null },
    });
    expect(JSON.stringify(seen.json())).not.toContain('@');
    expect((await guest.get(`/api/projects/${project.id}`)).statusCode).toBe(404);
    expect((await owner.get(`/api/share/${editorLink.token}`)).json()).toMatchObject({ preview: { currentRole: 'owner' } });
    expect((await guest.get('/api/share/no-existe')).json()).toMatchObject({ error: 'invalid_link' });
  });

  it('unirse se queda con el rol más alto; un enlace revocado o vencido no sirve; el token no se vuelve a ver', async () => {
    const viewer = await member('lector@ejemplo.com', 'viewer');
    const editorLink = await link('editor');
    expect((await viewer.post(`/api/share/${editorLink.token}/join`)).json()).toMatchObject({ role: 'editor' });
    expect((await viewer.post(`/api/share/${(await link('viewer')).token}/join`)).json()).toMatchObject({ role: 'editor' });
    expect((await owner.post(`/api/share/${editorLink.token}/join`)).json()).toMatchObject({ role: 'owner' });

    const listed = (await owner.get(`/api/projects/${project.id}/share-links`)).json<{ links: object[] }>().links;
    expect(listed).toContainEqual({ id: editorLink.id, role: 'editor', createdAt: editorLink.createdAt, expiresAt: null, recipientEmail: null });
    expect(JSON.stringify(listed)).not.toContain(editorLink.token);

    const late = await harness.user('tarde@ejemplo.com');
    expect((await owner.delete(`/api/projects/${project.id}/share-links/${editorLink.id}`)).statusCode).toBe(204);
    expect((await late.post(`/api/share/${editorLink.token}/join`)).json()).toMatchObject({ error: 'invalid_link' });

    const expiring = await link('viewer', { expiresInDays: 1 });
    await db.update(shareLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shareLinks.id, expiring.id));
    expect((await late.post(`/api/share/${expiring.token}/join`)).statusCode).toBe(404);
    expect((await late.post('/api/share/no-existe/join')).statusCode).toBe(404);
    expect((await late.get(`/api/projects/${project.id}`)).statusCode).toBe(404);
  });
});
