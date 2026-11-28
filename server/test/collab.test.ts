// Colaboración de punta a punta: Hocuspocus en el mismo puerto que la API, sesión en el upgrade,
// permisos por proyecto (lector en solo lectura, ajeno rechazado), cierre de conexiones al quitar
// permisos, avisos `files-changed`, tope de documento y persistencia en Postgres.
import { and, eq } from 'drizzle-orm';
import { mutationAudit, projectMembers } from '../src/schema';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import type { ProjectFile, ProjectSummary } from '@latexweb/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildApp } from '../src/app';
import { closeDb } from '../src/db';
import { COLLAB_PATH } from '../src/features/collab/websocket';
import { LIMITS, ORIGIN, projectsApp, resetDb, testDb, testStorage, type Client, type ProjectsHarness } from './helpers';

/**
 * Manda una petición de upgrade cruda a `base` y devuelve la primera línea de la respuesta.
 * `headers` reemplaza o agrega cabeceras (valor `null` = omitir).
 */
function rawUpgrade(base: string, target: string, headers: Record<string, string | null> = {}): Promise<string> {
  return new Promise((resolve) => {
    const [host, port] = base.split(':');
    const merged: Record<string, string | null> = {
      Host: base,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      ...headers,
    };
    const head = Object.entries(merged)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    const socket = connect(Number(port), host ?? '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\n${head}\r\n`));
    let response = '';
    const finish = () => {
      socket.destroy();
      resolve(response.split('\r\n')[0] ?? '');
    };
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
      if (response.includes('\r\n')) finish();
    });
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

const listenBase = async (app: FastifyInstance) => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
};

describe('upgrade de /collab', () => {
  let app: FastifyInstance;
  let base: string;
  beforeEach(async () => {
    app = await buildApp();
    base = await listenBase(app);
  });
  afterEach(() => app.close());

  it('comparte puerto con la API; solo /collab es un upgrade válido, y sin sesión es 401', async () => {
    expect((await fetch(`http://${base}/api/health`)).status).toBe(200);
    expect(await rawUpgrade(base, COLLAB_PATH, { Origin: ORIGIN })).toBe('HTTP/1.1 401 Unauthorized');
    for (const path of ['/', '/api/health', '/collab/otro']) expect(await rawUpgrade(base, path)).toBe('HTTP/1.1 404 Not Found');
  });

  it('rechaza un Host o un Origin ajenos', async () => {
    expect(await rawUpgrade(base, COLLAB_PATH, { Host: 'evil.com', Origin: ORIGIN })).toBe('HTTP/1.1 403 Forbidden');
    for (const origin of ['http://evil.com', 'null']) {
      expect(await rawUpgrade(base, COLLAB_PATH, { Origin: origin })).toBe('HTTP/1.1 403 Forbidden');
    }
    // El mismo origen que el Host pasa la guarda (sin sesión, 401), como en la API.
    expect(await rawUpgrade(base, COLLAB_PATH, { Origin: `http://${base}` })).toBe('HTTP/1.1 401 Unauthorized');
  });

  // Regresión: `new URL()` lanzaba fuera del try y la promesa rechazada terminaba el proceso.
  it.each(['//%', 'http://['])('una URL ilegible (%s) da 400 y el servidor sigue respondiendo', async (target) => {
    expect(await rawUpgrade(base, target, { Host: 'x' })).toBe('HTTP/1.1 400 Bad Request');
    expect((await fetch(`http://${base}/api/health`)).status).toBe(200);
  });
});

// --- Protocolo de Hocuspocus, codificado a mano para no depender de @hocuspocus/provider ---
// Mensaje: varString(documento) · varUint(tipo) · contenido.
const SYNC = 0;
const AUTH = 2;
const STATELESS = 5;
const CLOSE = 7;
const SYNC_STATUS = 8;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;
const AUTH_TOKEN = 0;
const AUTH_AUTHENTICATED = 2;

function varUint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return bytes;
}
const varBytes = (data: Uint8Array) => [...varUint(data.length), ...data];
const varString = (text: string) => varBytes(new TextEncoder().encode(text));

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  varUint(): number {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = this.bytes[this.offset++] ?? 0;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  }
  varBytes(): Uint8Array {
    const length = this.varUint();
    this.offset += length;
    return this.bytes.subarray(this.offset - length, this.offset);
  }
  varString(): string {
    return new TextDecoder().decode(this.varBytes());
  }
}

type Event =
  | { kind: 'authenticated'; scope: string }
  | { kind: 'denied' }
  | { kind: 'stateless'; payload: string }
  | { kind: 'close'; reason: string }
  | { kind: 'saved'; ok: boolean };

interface YClient {
  events: Event[];
  text(fileId: string): string;
  edit(fileId: string, fn: (text: Y.Text) => void): void;
  close(): void;
}

// El WebSocket de Node (undici) acepta cabeceras; el tipo del DOM no lo declara.
const WebSocketWithHeaders = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
const REMOTE = Symbol('remoto');

/** Cliente mínimo: se autentica, sincroniza el documento del proyecto y envía sus cambios. */
async function yClient(base: string, projectId: string, cookie: string): Promise<YClient> {
  const name = `project:${projectId}`;
  const socket = new WebSocketWithHeaders(`ws://${base}${COLLAB_PATH}`, { headers: { cookie, origin: ORIGIN } });
  socket.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const doc = new Y.Doc();
  const events: Event[] = [];
  const send = (bytes: number[]) => socket.send(Uint8Array.from([...varString(name), ...bytes]));
  socket.addEventListener('message', (event: MessageEvent) => {
    const reader = new Reader(new Uint8Array(event.data as ArrayBuffer));
    if (reader.varString() !== name) return;
    const type = reader.varUint();
    if (type === SYNC) {
      const step = reader.varUint();
      if (step === SYNC_STEP2 || step === SYNC_UPDATE) Y.applyUpdate(doc, reader.varBytes(), REMOTE);
    } else if (type === AUTH) {
      events.push(reader.varUint() === AUTH_AUTHENTICATED ? { kind: 'authenticated', scope: reader.varString() } : { kind: 'denied' });
    } else if (type === STATELESS) events.push({ kind: 'stateless', payload: reader.varString() });
    else if (type === CLOSE) events.push({ kind: 'close', reason: reader.varString() });
    else if (type === SYNC_STATUS) events.push({ kind: 'saved', ok: reader.varUint() === 1 });
  });
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) send([SYNC, SYNC_UPDATE, ...varBytes(update)]);
  });
  send([AUTH, AUTH_TOKEN, ...varString('')]);
  send([SYNC, SYNC_STEP1, ...varBytes(Y.encodeStateVector(doc))]);
  await expect.poll(() => events.find((e) => e.kind === 'authenticated' || e.kind === 'denied')).toBeDefined();
  return {
    events,
    text: (fileId) => doc.getMap<Y.Text>('files').get(fileId)?.toString() ?? '',
    edit(fileId, fn) {
      const text = doc.getMap<Y.Text>('files').get(fileId);
      if (!text) throw new Error(`sin el archivo ${fileId}`);
      fn(text);
    },
    close: () => socket.close(),
  };
}

describe('colaboración en un proyecto', () => {
  const db = testDb();
  const storage = testStorage();
  afterAll(async () => {
    await closeDb(db);
    storage.close();
  });

  let harness: ProjectsHarness;
  let base: string;
  let owner: Client;
  let project: ProjectSummary;
  let mainId: string;
  const clients: YClient[] = [];

  async function start() {
    harness = await projectsApp(db, storage);
    base = await listenBase(harness.app);
  }
  beforeEach(async () => {
    await resetDb(db);
    await start();
    owner = await harness.user('duena@ejemplo.com');
    project = (await owner.post('/api/projects', { name: 'Vivo' })).json<{ project: ProjectSummary }>().project;
    mainId = (await owner.get(`/api/projects/${project.id}/files`)).json<{ files: ProjectFile[] }>().files[0]?.id ?? '';
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await harness.app.close();
  });

  const open = async (client: Client) => {
    const y = await yClient(base, project.id, client.cookie);
    clients.push(y);
    return y;
  };
  async function member(email: string, role: 'editor' | 'viewer'): Promise<Client> {
    const client = await harness.user(email);
    const { link } = (await owner.post(`/api/projects/${project.id}/share-links`, { role })).json<{ link: { token: string } }>();
    await client.post(`/api/share/${link.token}/join`);
    return client;
  }

  it('dos editores se sincronizan; lo editado se ve por REST y sobrevive a reiniciar el server', async () => {
    const a = await open(owner);
    const b = await open(await member('editor@ejemplo.com', 'editor'));
    expect([a.events[0], b.events[0]]).toEqual([
      { kind: 'authenticated', scope: 'read-write' },
      { kind: 'authenticated', scope: 'read-write' },
    ]);
    await expect.poll(() => b.text(mainId)).toContain('\\documentclass');

    a.edit(mainId, (text) => text.insert(0, '% hola desde A\n'));
    await expect.poll(() => b.text(mainId)).toMatch(/^% hola desde A\n/);
    const file = `/api/projects/${project.id}/files/${mainId}`;
    expect((await owner.get(file)).body).toMatch(/^% hola desde A\n/);
    await expect.poll(async () => (await db.select().from(mutationAudit).where(and(
      eq(mutationAudit.projectId, project.id), eq(mutationAudit.source, 'collab'), eq(mutationAudit.outcome, 'applied'),
    ))).length).toBe(1);
    const [entry] = await db.select().from(mutationAudit).where(eq(mutationAudit.source, 'collab'));
    expect(entry).toMatchObject({ actorId: owner.userId, outcome: 'applied' });
    expect(entry?.before?.snapshotSha256).not.toBe(entry?.after?.snapshotSha256);
    expect(JSON.stringify(entry)).not.toContain('hola desde A');

    // Al cerrar, el server guarda los documentos abiertos; otro server los lee de Postgres.
    await harness.app.close();
    await start();
    const get = (url: string) => harness.app.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
    const after = await get(file);
    expect(after.body).toMatch(/^% hola desde A\n/);
    const [main] = (await get(`/api/projects/${project.id}/files`)).json<{ files: ProjectFile[] }>().files;
    expect(main?.size).toBe(Buffer.byteLength(after.body));
  });

  it('atribuye updates concurrentes a sus sesiones y registra también un borrado de texto', async () => {
    const editor = await member('concurrente@ejemplo.com', 'editor');
    const a = await open(owner);
    const b = await open(editor);
    await expect.poll(() => b.text(mainId)).toContain('\\documentclass');
    a.edit(mainId, (text) => text.insert(0, 'PRIVADO_A'));
    b.edit(mainId, (text) => text.insert(0, 'PRIVADO_B'));
    const events = () => db.select().from(mutationAudit).where(and(
      eq(mutationAudit.projectId, project.id), eq(mutationAudit.source, 'collab'), eq(mutationAudit.outcome, 'applied'),
    ));
    await expect.poll(async () => (await events()).map((e) => e.actorId).sort()).toEqual([owner.userId, editor.userId].sort());
    await expect.poll(() => a.text(mainId)).toContain('PRIVADO_B');
    a.edit(mainId, (text) => text.delete(0, 1));
    await expect.poll(async () => (await events()).length).toBe(3);
    for (const event of await events()) {
      expect(event.before?.snapshotSha256).not.toBe(event.after?.snapshotSha256);
      expect(event.after?.updateSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(event)).not.toContain('PRIVADO_');
    }
  });

  it('un lector entra en solo lectura y sus cambios no se aplican; un ajeno es rechazado', async () => {
    const a = await open(owner);
    const viewer = await open(await member('lector@ejemplo.com', 'viewer'));
    expect(viewer.events[0]).toEqual({ kind: 'authenticated', scope: 'readonly' });
    await expect.poll(() => viewer.text(mainId)).toContain('\\documentclass');

    viewer.edit(mainId, (text) => text.insert(0, 'INTRUSO'));
    await expect.poll(() => viewer.events).toContainEqual({ kind: 'saved', ok: false });
    expect(a.text(mainId)).not.toContain('INTRUSO');
    await expect.poll(async () => (await db.select().from(mutationAudit).where(and(
      eq(mutationAudit.projectId, project.id), eq(mutationAudit.source, 'collab'), eq(mutationAudit.outcome, 'denied'),
    ))).length).toBe(1);
    expect((await owner.get(`/api/projects/${project.id}/files/${mainId}`)).body).not.toContain('INTRUSO');

    const stranger = await open(await harness.user('ajena@ejemplo.com'));
    expect(stranger.events).toEqual([{ kind: 'denied' }]);
    expect(stranger.text(mainId)).toBe('');
    expect(await rawUpgrade(base, COLLAB_PATH, { Cookie: 'sid=inventada' })).toBe('HTTP/1.1 401 Unauthorized');
  });

  it('quitar a un miembro o bajarlo a lector cierra sus conexiones; al volver, entra con el rol nuevo', async () => {
    const editor = await member('editor@ejemplo.com', 'editor');
    const viewer = await member('lector@ejemplo.com', 'viewer');
    const e = await open(editor);
    const v = await open(viewer);
    const members = `/api/projects/${project.id}/members`;

    await owner.patch(`${members}/${editor.userId}`, { role: 'viewer' });
    await expect.poll(() => e.events).toContainEqual({ kind: 'close', reason: 'permissions-changed' });
    expect((await open(editor)).events[0]).toEqual({ kind: 'authenticated', scope: 'readonly' });

    await owner.delete(`${members}/${viewer.userId}`);
    await expect.poll(() => v.events).toContainEqual({ kind: 'close', reason: 'permissions-changed' });
    expect((await open(viewer)).events).toEqual([{ kind: 'denied' }]);
  });

  it('no aplica mensajes enviados con una sesión cerrada después del upgrade', async () => {
    const a = await open(owner);
    await expect.poll(() => a.text(mainId)).toContain('\\documentclass');
    expect((await owner.post('/api/auth/logout')).statusCode).toBe(204);
    a.edit(mainId, (text) => text.insert(0, 'SESION_REVOCADA'));
    await expect.poll(() => a.events).toContainEqual({ kind: 'close', reason: 'session-expired' });
    // Una sesión nueva comprueba el estado que realmente conservó el servidor.
    const login = await harness.app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN },
      payload: { email: 'duena@ejemplo.com', password: 'clave-larga-1' },
    });
    const cookie = login.cookies.find((c) => c.name === 'sid');
    const stored = await harness.app.inject({
      url: `/api/projects/${project.id}/files/${mainId}`, headers: { cookie: `sid=${cookie?.value}` },
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.body).not.toContain('SESION_REVOCADA');
  });

  it('relee el rol y la membresía de cada mensaje aunque cambien fuera de esta instancia', async () => {
    const editor = await member('otro-nodo@ejemplo.com', 'editor');
    const socket = await open(editor);
    await expect.poll(() => socket.text(mainId)).toContain('\\documentclass');
    const key = and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, editor.userId));
    // No usa el servicio ni docs.disconnect: simula otro nodo o una revocación administrativa.
    await db.update(projectMembers).set({ role: 'viewer' }).where(key);
    socket.edit(mainId, (text) => text.insert(0, 'ROL_ANTIGUO_NO_DEBE_ESCRIBIR'));
    await expect.poll(() => socket.events).toContainEqual({ kind: 'saved', ok: false });
    expect((await owner.get(`/api/projects/${project.id}/files/${mainId}`)).body).not.toContain('ROL_ANTIGUO');
    await db.delete(projectMembers).where(key);
    socket.edit(mainId, (text) => text.insert(0, 'MIEMBRO_REVOCADO'));
    await expect.poll(() => socket.events).toContainEqual({ kind: 'close', reason: 'permissions-changed' });
    expect((await owner.get(`/api/projects/${project.id}/files/${mainId}`)).body).not.toContain('MIEMBRO_REVOCADO');
  });

  it('avisa a los conectados cuando cambian los archivos o el proyecto por REST', async () => {
    const a = await open(owner);
    await owner.upload(`/api/projects/${project.id}/files`, { 'cap.tex': 'x' });
    await owner.patch(`/api/projects/${project.id}`, { engine: 'xelatex' });
    await expect.poll(() => a.events.filter((e) => e.kind === 'stateless')).toEqual([
      { kind: 'stateless', payload: '{"type":"files-changed"}' },
      { kind: 'stateless', payload: '{"type":"project-changed"}' },
    ]);
  });

  it('un documento no puede pasar el tope: se cierra la conexión y no se guarda', async () => {
    const a = await open(owner);
    await expect.poll(() => a.text(mainId)).toContain('\\documentclass');
    a.edit(mainId, (text) => text.insert(0, 'x'.repeat(LIMITS.docMaxBytes)));
    await expect.poll(() => a.events).toContainEqual({ kind: 'close', reason: 'document-too-large' });
    expect((await owner.get(`/api/projects/${project.id}/files/${mainId}`)).body).not.toMatch(/^x/);
  });
});
