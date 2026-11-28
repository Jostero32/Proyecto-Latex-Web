import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb } from '../src/db';
import { projectsApp, resetDb, testDb, testStorage, type ProjectsHarness } from './helpers';

const db = testDb();
const storage = testStorage();
let h: ProjectsHarness;
beforeEach(async () => { await resetDb(db); h = await projectsApp(db, storage); });
afterEach(() => h.app.close());
afterAll(async () => { await closeDb(db); storage.close(); });

it('las identidades y privilegios del body no cambian el actor ni la membresía; el dueño puede renombrar', async () => {
  const owner = await h.user('owner@example.com');
  const outsider = await h.user('other@example.com');
  const project = (await owner.post('/api/projects', { name: 'Original', userId: outsider.userId, role: 'viewer' })).json().project as { id: string; role: string };
  const path = `/api/projects/${project.id}`;
  const attack = { role: 'owner', userId: owner.userId, ownerId: outsider.userId, privacy: { accepted: true }, googleSubject: 'invented' };
  expect(project.role).toBe('owner');
  expect((await outsider.patch(path, { name: 'Intruso', ...attack })).statusCode).toBe(404);
  expect((await owner.patch(path, { ...attack, name: 'Renombrado legítimo' })).json()).toMatchObject({ project: { name: 'Renombrado legítimo', role: 'owner' } });
  expect((await owner.patch(path, attack)).statusCode).toBe(400);
  const created = (await owner.post(`${path}/share-links`, { role: 'viewer', userId: owner.userId })).json().link as { token: string };
  await outsider.post(`/api/share/${created.token}/join`);
  expect((await outsider.patch(path, { name: 'Escalada', ...attack })).statusCode).toBe(403);
  expect((await outsider.patch(`${path}/members/${outsider.userId}`, { role: 'editor' })).statusCode).toBe(403);
  const main = (await owner.get(`${path}/files`)).json().files[0] as { id: string };
  expect((await owner.patch(`${path}/files/${main.id}`, { path: 'renombrado.tex', ...attack })).statusCode).toBe(200);
  expect((await owner.get(`${path}/members`)).json().members).toEqual(expect.arrayContaining([
    expect.objectContaining({ userId: owner.userId, role: 'owner' }), expect.objectContaining({ userId: outsider.userId, role: 'viewer' }),
  ]));
  expect((await owner.get(path)).json()).toMatchObject({ project: { name: 'Renombrado legítimo', mainFile: 'renombrado.tex' } });
  expect((await owner.get('/api/auth/me')).json().user.privacy).not.toHaveProperty('accepted');
});

it('valida Origin y también Referer cuando existe, sin aceptar sustituciones mediante cabeceras', async () => {
  const owner = await h.user('owner@example.com');
  const { project } = (await owner.post('/api/projects', { name: 'CSRF' })).json() as { project: { id: string } };
  const url = `/api/projects/${project.id}`;
  for (const referer of ['https://evil.example/ataque', 'no-es-url', 'null']) {
    const result = await owner.request({ method: 'PATCH', url, payload: { name: 'No autorizado' }, headers: { referer } });
    expect(result.statusCode).toBe(403);
  }
  expect((await owner.request({ method: 'PATCH', url, payload: { name: 'Permitido' }, headers: { referer: 'http://localhost:55173/proyectos' } })).statusCode).toBe(200);
  expect((await owner.request({ method: 'PATCH', url, payload: { name: 'Sin Origin' }, headers: { origin: '', referer: 'http://localhost:55173/' } })).statusCode).toBe(403);
});
