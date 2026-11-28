import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb } from '../src/db';
import { createMutationAudit } from '../src/features/audit/service';
import { mutationAudit } from '../src/schema';
import { LIMITS, projectsApp, resetDb, testDb, testStorage, type ProjectsHarness } from './helpers';

const db = testDb();
const storage = testStorage();
let h: ProjectsHarness;
beforeEach(async () => { await resetDb(db); h = await projectsApp(db, storage); });
afterEach(async () => { vi.restoreAllMocks(); await h.app.close(); });
afterAll(async () => { await closeDb(db); storage.close(); });

it('registra actor real y antes/después; limita la consulta al dueño y conserva el historial al borrar', async () => {
  const owner = await h.user('owner@example.com');
  const other = await h.user('other@example.com');
  const { project } = (await owner.post('/api/projects', { name: 'Antes' })).json() as { project: { id: string } };
  const path = `/api/projects/${project.id}`;
  expect((await owner.patch(path, { name: 'Después', userId: other.userId })).statusCode).toBe(200);
  const history = (await owner.get(`${path}/audit-events`)).json();
  expect(history.events).toHaveLength(2);
  expect(history.events[0]).toMatchObject({ actorId: owner.userId, outcome: 'applied', statusCode: 200,
    before: { project: { name: 'Antes' } }, after: { project: { name: 'Después' } } });
  expect((await owner.get(`${path}/audit-events?limit=1`)).json().events).toHaveLength(1);
  expect((await owner.get(`${path}/audit-events?limit=101`)).statusCode).toBe(400);
  expect((await other.get(`${path}/audit-events`)).statusCode).toBe(404);
  const link = (await owner.post(`${path}/share-links`, { role: 'viewer' })).json().link as { token: string };
  await other.post(`/api/share/${link.token}/join`);
  expect((await other.get(`${path}/audit-events`)).statusCode).toBe(403);
  expect((await other.patch(path, { name: 'No autorizado' })).statusCode).toBe(403);
  const denied = (await owner.get(`${path}/audit-events`)).json().events[0];
  expect(denied).toMatchObject({ actorId: other.userId, outcome: 'denied', statusCode: 403 });
  expect(denied.before).toEqual(denied.after);
  const logs = await db.select().from(mutationAudit);
  expect(JSON.stringify(logs)).not.toContain(link.token);
  expect(JSON.stringify(logs)).not.toContain(owner.cookie);
  expect((await owner.delete(path)).statusCode).toBe(204);
  expect(await db.select().from(mutationAudit).where(eq(mutationAudit.projectId, project.id))).toEqual(expect.arrayContaining([
    expect.objectContaining({ actorId: owner.userId, action: 'DELETE /api/projects/:id', outcome: 'applied', after: null }),
  ]));
});

it('registra hashes de texto y roles sin guardar el contenido del documento', async () => {
  const owner = await h.user('owner@example.com');
  const editor = await h.user('editor@example.com');
  const { project } = (await owner.post('/api/projects', { name: 'Texto privado' })).json() as { project: { id: string } };
  const path = `/api/projects/${project.id}`;
  const { files } = (await owner.get(`${path}/files`)).json() as { files: { id: string }[] };
  const filePath = `${path}/files/${files[0]!.id}`;
  const secret = 'CONTENIDO_PRIVADO_NO_COPIAR_A_BITACORA';
  expect((await owner.put(filePath, secret)).statusCode).toBe(200);
  const event = (await owner.get(`${path}/audit-events`)).json().events[0];
  expect(event.before.textSha256).not.toBe(event.after.textSha256);
  expect(event.after.textSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(event)).not.toContain(secret);
  const link = (await owner.post(`${path}/share-links`, { role: 'editor' })).json().link as { token: string };
  await editor.post(`/api/share/${link.token}/join`);
  expect((await owner.patch(`${path}/members/${editor.userId}`, { role: 'viewer' })).statusCode).toBe(200);
  expect((await owner.get(`${path}/audit-events`)).json().events[0]).toMatchObject({
    before: { member: { userId: editor.userId, role: 'editor' } }, after: { member: { userId: editor.userId, role: 'viewer' } },
  });
});

it('no ejecuta sin intención duradera y deja pendiente una operación cuyo cierre de bitácora falla', async () => {
  await h.app.close();
  const audit = createMutationAudit(db);
  h = await projectsApp(db, storage, LIMITS, audit);
  const owner = await h.user('owner@example.com');
  const { project } = (await owner.post('/api/projects', { name: 'Original' })).json() as { project: { id: string } };
  const path = `/api/projects/${project.id}`;
  const begin = vi.spyOn(audit, 'begin').mockRejectedValueOnce(new Error('BD no disponible'));
  expect((await owner.patch(path, { name: 'No ejecutar' })).statusCode).toBe(503);
  expect((await owner.get(path)).json().project.name).toBe('Original');
  begin.mockRestore();
  vi.spyOn(audit, 'finish').mockRejectedValueOnce(new Error('fallo al finalizar'));
  const response = await owner.patch(path, { name: 'Aplicado con registro pendiente' });
  expect(response.statusCode).toBe(503);
  expect(response.body).toContain('comprueba el estado');
  expect((await owner.get(path)).json().project.name).toBe('Aplicado con registro pendiente');
  expect((await owner.get(`${path}/audit-events`)).json().events[0]).toMatchObject({ outcome: 'pending', completedAt: null });
});
