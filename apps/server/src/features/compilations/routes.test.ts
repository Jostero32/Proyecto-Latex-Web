import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompileJobData, CompileJobResult } from '@latexweb/shared';
import { buildApp } from '../../app';
import type { CompilationsConfig } from '../../config';
import type { CompileQueue, JobSnapshot } from './queue';
import { createLocalCompilationsStorage } from './storage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MB = 1024 * 1024;

interface FakeQueue extends CompileQueue {
  added: CompileJobData[];
  waiting: number;
  failWaitingCount: boolean;
  failAdd: boolean;
  jobs: Map<string, JobSnapshot>;
  getCalls: number;
  failGet: Error | null;
}

function createFakeQueue(): FakeQueue {
  const queue: FakeQueue = {
    added: [],
    waiting: 0,
    failWaitingCount: false,
    failAdd: false,
    jobs: new Map(),
    getCalls: 0,
    failGet: null,
    async add(data) {
      if (queue.failAdd) throw new Error('redis caído');
      queue.added.push(data);
    },
    async waitingCount() {
      if (queue.failWaitingCount) throw new Error('redis caído');
      return queue.waiting;
    },
    async get(id) {
      queue.getCalls++;
      if (queue.failGet) throw queue.failGet;
      return queue.jobs.get(id) ?? null;
    },
    async close() {},
  };
  return queue;
}

const baseConfig = (root: string): CompilationsConfig => ({
  storageDir: root,
  upload: { maxFileBytes: 20 * MB, maxTotalBytes: 50 * MB, maxFiles: 200 },
  maxQueued: 50,
  ttlSeconds: 3600,
  maxPdfBytes: 50 * MB,
});

let root: string;
let queue: FakeQueue;
let app: FastifyInstance;

async function start(config: CompilationsConfig = baseConfig(root)): Promise<void> {
  app = await buildApp({
    compilations: { queue, storage: createLocalCompilationsStorage(root), config },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'latexweb-routes-test-'));
  queue = createFakeQueue();
  await start();
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

interface FileSpec {
  name: string;
  content?: string | Uint8Array;
  field?: string;
}

async function multipart(
  files: FileSpec[],
  fields: Record<string, string> = {},
): Promise<{ payload: Buffer; headers: { 'content-type': string } }> {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  for (const f of files) {
    fd.append(f.field ?? 'files', new Blob([f.content ?? 'x']), f.name);
  }
  const request = new Request('http://localhost/', { method: 'POST', body: fd });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { 'content-type': request.headers.get('content-type') ?? '' },
  };
}

async function upload(files: FileSpec[], fields: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/compilations', ...(await multipart(files, fields)) });
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

function expectErrorShape(body: unknown, code: string): void {
  expect(body).toEqual({ error: code, message: expect.any(String) });
}

describe('POST /compilations: subida válida', () => {
  it('responde 202, guarda los archivos y encola', async () => {
    const res = await upload([
      { name: 'main.tex', content: '% !TEX program = xelatex\nhola' },
      { name: 'figuras/a.png', content: 'PNG' },
    ]);
    expect(res.statusCode).toBe(202);
    const body = res.json<{ id: string; status: string; engine: string; mainFile: string; ignoredFiles: string[] }>();
    expect(body.id).toMatch(UUID);
    expect(res.headers.location).toBe(`/compilations/${body.id}`);
    expect(body).toEqual({ id: body.id, status: 'queued', engine: 'xelatex', mainFile: 'main.tex', ignoredFiles: [] });

    const input = join(root, body.id, 'input');
    expect(await readFile(join(input, 'main.tex'), 'utf8')).toContain('hola');
    expect(await readFile(join(input, 'figuras', 'a.png'), 'utf8')).toBe('PNG');
    expect(queue.added).toEqual([{ compilationId: body.id, mainFile: 'main.tex', engine: 'xelatex' }]);
  });

  it('respeta mainFile y engine explícitos', async () => {
    const res = await upload([{ name: 'tesis/main.tex' }], { mainFile: 'tesis/main.tex', engine: 'lualatex' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ engine: 'lualatex', mainFile: 'tesis/main.tex' });
    expect(queue.added[0]).toMatchObject({ mainFile: 'tesis/main.tex', engine: 'lualatex' });
  });

  it('latexmkrc y .latexmkrc se ignoran y no quedan en disco', async () => {
    const res = await upload([{ name: 'main.tex' }, { name: 'latexmkrc' }, { name: '.latexmkrc' }]);
    expect(res.statusCode).toBe(202);
    const body = res.json<{ id: string; ignoredFiles: string[] }>();
    expect([...body.ignoredFiles].sort()).toEqual(['.latexmkrc', 'latexmkrc']);
    expect((await readdir(join(root, body.id, 'input'))).sort()).toEqual(['main.tex']);
  });
});

describe('POST /compilations: errores 400', () => {
  it.each([
    ['ruta con ..', [{ name: 'main.tex' }, { name: '../x' }], {}, 'invalid_path'],
    ['duplicado', [{ name: 'main.tex' }, { name: 'Main.tex' }], {}, 'duplicate_path'],
    ['sin main.tex', [{ name: 'otro.tex' }], {}, 'main_file_missing'],
    ['motor inválido', [{ name: 'main.tex' }], { engine: 'latex' }, 'invalid_engine'],
    ['campo distinto de files', [{ name: 'main.tex', field: 'archivos' }], {}, 'invalid_request'],
  ] as const)('%s: %s', async (_label, files, fields, code) => {
    const res = await upload([...files], { ...fields });
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json(), code);
    expect(queue.added).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('sin archivos: no_files', async () => {
    const res = await upload([], { mainFile: 'main.tex' });
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json(), 'no_files');
  });

  it('mainFile de más de 1024 bytes: invalid_request', async () => {
    const res = await upload([{ name: 'main.tex' }], { mainFile: 'a'.repeat(2000) });
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json(), 'invalid_request');
  });
});

describe('POST /compilations: límites 413', () => {
  const small = (): CompilationsConfig => ({
    ...baseConfig(root),
    upload: { maxFileBytes: 100, maxTotalBytes: 150, maxFiles: 2 },
  });

  beforeEach(async () => {
    await app.close();
    await start(small());
  });

  it('archivo mayor que maxFileBytes: file_too_large', async () => {
    const res = await upload([{ name: 'main.tex', content: 'a'.repeat(101) }]);
    expect(res.statusCode).toBe(413);
    expectErrorShape(res.json(), 'file_too_large');
    expect(await readdir(root)).toEqual([]);
  });

  it('más archivos que maxFiles: too_many_files', async () => {
    const res = await upload([{ name: 'main.tex' }, { name: 'a.tex' }, { name: 'b.tex' }]);
    expect(res.statusCode).toBe(413);
    expectErrorShape(res.json(), 'too_many_files');
    expect(await readdir(root)).toEqual([]);
  });

  it('total mayor que maxTotalBytes: payload_too_large', async () => {
    const res = await upload([
      { name: 'main.tex', content: 'a'.repeat(80) },
      { name: 'b.tex', content: 'b'.repeat(80) },
    ]);
    expect(res.statusCode).toBe(413);
    expectErrorShape(res.json(), 'payload_too_large');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('POST /compilations: cuerpo que no es multipart', () => {
  it('JSON: 415 invalid_request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/compilations',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 1 }),
    });
    expect(res.statusCode).toBe(415);
    expectErrorShape(res.json(), 'invalid_request');
  });

  it('text/plain: Fastify lo parsea como texto y responde nuestro 415 invalid_request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/compilations',
      headers: { 'content-type': 'text/plain' },
      payload: 'hola',
    });
    expect(res.statusCode).toBe(415);
    expectErrorShape(res.json(), 'invalid_request');
  });

  it('application/octet-stream: el 415 que genera Fastify antes del handler también usa { error, message }', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/compilations',
      headers: { 'content-type': 'application/octet-stream' },
      payload: 'hola',
    });
    expect(res.statusCode).toBe(415);
    expectErrorShape(res.json(), 'invalid_request');
  });
});

describe('POST /compilations: errores internos', () => {
  it('un fallo inesperado responde 500 internal_error sin exponer el mensaje interno', async () => {
    await app.close();
    const real = createLocalCompilationsStorage(root);
    app = await buildApp({
      compilations: {
        queue,
        config: baseConfig(root),
        storage: {
          ...real,
          saveInputs: async () => {
            throw new Error(`EACCES: permission denied, open '${root}/secreto/input/main.tex'`);
          },
        },
      },
    });
    const res = await upload([{ name: 'main.tex' }]);
    expect(res.statusCode).toBe(500);
    expectErrorShape(res.json(), 'internal_error');
    expect(res.body).not.toContain('EACCES');
    expect(res.body).not.toContain(root.replace(/\\/g, '\\\\'));
    expect(res.body).not.toContain('secreto');
  });
});

describe('POST /compilations: cola', () => {
  it('cola llena: 503 queue_full con Retry-After y sin archivos', async () => {
    queue.waiting = 50;
    const res = await upload([{ name: 'main.tex' }]);
    expect(res.statusCode).toBe(503);
    expectErrorShape(res.json(), 'queue_full');
    expect(res.headers['retry-after']).toBeDefined();
    expect(await readdir(root)).toEqual([]);
    expect(queue.added).toEqual([]);
  });

  it('cola caída: 503 sin archivos', async () => {
    queue.failWaitingCount = true;
    const res = await upload([{ name: 'main.tex' }]);
    expect(res.statusCode).toBe(503);
    expectErrorShape(res.json(), 'queue_full');
    expect(await readdir(root)).toEqual([]);
  });

  it('fallo al encolar: 503 con Retry-After y directorio borrado', async () => {
    queue.failAdd = true;
    const res = await upload([{ name: 'main.tex' }]);
    expect(res.statusCode).toBe(503);
    expectErrorShape(res.json(), 'queue_full');
    expect(res.headers['retry-after']).toBeDefined();
    expect(await readdir(root)).toEqual([]);
  });

  it('cola con espacio justo por debajo del máximo acepta', async () => {
    queue.waiting = 49;
    const res = await upload([{ name: 'main.tex' }]);
    expect(res.statusCode).toBe(202);
    expect(await exists(join(root, res.json<{ id: string }>().id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /compilations/:id, /pdf y /log
// ---------------------------------------------------------------------------

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';

const okResult = (over: Partial<CompileJobResult> = {}): CompileJobResult => ({
  outcome: 'success',
  exitCode: 0,
  durationMs: 1234,
  hasPdf: true,
  hasLog: true,
  pdfMissingReason: null,
  ...over,
});

function setJob(over: Partial<JobSnapshot> = {}): JobSnapshot {
  const snapshot: JobSnapshot = {
    state: 'completed',
    data: { compilationId: ID, mainFile: 'main.tex', engine: 'pdflatex' },
    createdAt: Date.now() - 5000,
    finishedAt: Date.now() - 1000,
    result: okResult(),
    ...over,
  };
  queue.jobs.set(ID, snapshot);
  return snapshot;
}

function setPending(state: 'queued' | 'running'): void {
  queue.jobs.set(ID, {
    state,
    data: { compilationId: ID, mainFile: 'main.tex', engine: 'pdflatex' },
    createdAt: Date.now() - 1000,
  });
}

async function writeArtifact(name: 'output.pdf' | 'output.log', content: string | Uint8Array): Promise<void> {
  await mkdir(join(root, ID), { recursive: true });
  await writeFile(join(root, ID, name), content);
}

const get = (url: string) => app.inject({ method: 'GET', url });

describe('GET /compilations/:id', () => {
  it.each(['no-es-uuid', ID.toUpperCase()])(
    'id inválido %s: 404 not_found sin consultar la cola',
    async (bad) => {
      for (const suffix of ['', '/pdf', '/log']) {
        const res = await get(`/compilations/${bad}${suffix}`);
        expect(res.statusCode).toBe(404);
        expectErrorShape(res.json(), 'not_found');
      }
      expect(queue.getCalls).toBe(0);
    },
  );

  // La URL se normaliza antes del router (`/compilations/..` pasa a `/`), así que ni siquiera llega
  // al handler: responde el 404 genérico de Fastify. Lo que importa es que no llegue a la cola.
  it.each(['..', '%2e%2e', '..%2f..%2fetc', '%2e%2e%5c'])('id %s: 404 sin consultar la cola', async (bad) => {
    for (const suffix of ['', '/pdf', '/log']) {
      const res = await get(`/compilations/${bad}${suffix}`);
      expect(res.statusCode).toBe(404);
    }
    expect(queue.getCalls).toBe(0);
  });

  it('id inexistente: 404 not_found', async () => {
    const res = await get(`/compilations/${ID}`);
    expect(res.statusCode).toBe(404);
    expectErrorShape(res.json(), 'not_found');
    expect(queue.getCalls).toBe(1);
  });

  it('queued: 200 con la forma de CompilationStatusResponse', async () => {
    setPending('queued');
    const res = await get(`/compilations/${ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: ID,
      status: 'queued',
      engine: 'pdflatex',
      mainFile: 'main.tex',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });

  it('completed: 200 con pdfUrl y logUrl', async () => {
    setJob();
    const res = await get(`/compilations/${ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: ID,
      status: 'success',
      durationMs: 1234,
      exitCode: 0,
      pdfMissingReason: null,
      pdfUrl: `/compilations/${ID}/pdf`,
      logUrl: `/compilations/${ID}/log`,
      finishedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it('si queue.get lanza: 500 internal_error sin el mensaje interno', async () => {
    queue.failGet = new Error(`ECONNREFUSED 10.0.0.5:6379 ${root}`);
    for (const suffix of ['', '/pdf', '/log']) {
      const res = await get(`/compilations/${ID}${suffix}`);
      expect(res.statusCode).toBe(500);
      expectErrorShape(res.json(), 'internal_error');
      expect(res.body).not.toContain('ECONNREFUSED');
      expect(res.body).not.toContain('6379');
    }
  });
});

describe('GET /compilations/:id/pdf', () => {
  it('200 con el contenido exacto y las cabeceras de seguridad', async () => {
    const content = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x0a, 0x3c, 0x73, 0x63, 0x72]);
    await writeArtifact('output.pdf', content);
    setJob();
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, content)).toBe(0);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['content-disposition']).toBe('inline; filename="output.pdf"');
    expect(res.headers['content-length']).toBe(String(content.length));
  });

  it.each(['queued', 'running'] as const)('%s: 409 not_ready', async (state) => {
    setPending(state);
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(409);
    expectErrorShape(res.json(), 'not_ready');
  });

  it('too_large: 404 pdf_too_large con el límite en el mensaje', async () => {
    setJob({ result: okResult({ outcome: 'error', hasPdf: false, pdfMissingReason: 'too_large' }) });
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(404);
    expectErrorShape(res.json(), 'pdf_too_large');
    expect(res.json<{ message: string }>().message).toContain(String(50 * MB));
  });

  it('not_produced: 404 artifact_not_available', async () => {
    setJob({ result: okResult({ outcome: 'error', hasPdf: false, pdfMissingReason: 'not_produced' }) });
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(404);
    expectErrorShape(res.json(), 'artifact_not_available');
  });

  it('failed: 404 artifact_not_available', async () => {
    setJob({ state: 'failed', result: undefined });
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(404);
    expectErrorShape(res.json(), 'artifact_not_available');
  });

  it('TTL vencido: 410 expired aunque el archivo exista', async () => {
    await writeArtifact('output.pdf', '%PDF-1.5');
    setJob({ finishedAt: Date.now() - 3600 * 1000 - 5000 });
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(410);
    expectErrorShape(res.json(), 'expired');
  });

  it('job completo pero archivo borrado: 410 expired', async () => {
    setJob();
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(410);
    expectErrorShape(res.json(), 'expired');
  });

  it('id inexistente: 404 not_found', async () => {
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(404);
    expectErrorShape(res.json(), 'not_found');
  });
});

describe('GET /compilations/:id/log', () => {
  it('200 text/plain utf-8 con nosniff y el contenido', async () => {
    const content = 'This is pdfTeX\n! Undefined control sequence. ñ <script>alert(1)</script>\n';
    await writeArtifact('output.log', content);
    setJob();
    const res = await get(`/compilations/${ID}/log`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['content-disposition']).toBe('inline; filename="output.log"');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(content)));
    expect(res.body).toBe(content);
  });

  it('archivo borrado: 410 expired', async () => {
    setJob();
    const res = await get(`/compilations/${ID}/log`);
    expect(res.statusCode).toBe(410);
    expectErrorShape(res.json(), 'expired');
  });

  it('log con bytes que no son UTF-8 se sirve igual', async () => {
    const content = Buffer.from([0x21, 0x20, 0xe9, 0xff, 0xfe, 0x80, 0x0a]);
    await writeArtifact('output.log', content);
    setJob();
    const res = await get(`/compilations/${ID}/log`);
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, content)).toBe(0);
  });

  it('hasLog false: 404 artifact_not_available', async () => {
    setJob({ result: okResult({ outcome: 'error', hasLog: false }) });
    const res = await get(`/compilations/${ID}/log`);
    expect(res.statusCode).toBe(404);
    expectErrorShape(res.json(), 'artifact_not_available');
  });
});

describe('GET artefactos: seguridad', () => {
  it('output.pdf es un directorio: no es 200 (410)', async () => {
    await mkdir(join(root, ID, 'output.pdf'), { recursive: true });
    setJob();
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(410);
    expectErrorShape(res.json(), 'expired');
  });

  const canSymlink = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'latexweb-symlink-probe-'));
    try {
      writeFileSync(join(dir, 'a'), 'x');
      symlinkSync(join(dir, 'a'), join(dir, 'b'), 'file');
      return true;
    } catch {
      return false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();

  it.skipIf(!canSymlink)('output.pdf es un symlink a un archivo externo: no se sirve (410)', async () => {
    const secret = join(root, 'secreto.txt');
    await writeFile(secret, 'contenido-secreto');
    await mkdir(join(root, ID), { recursive: true });
    await symlink(secret, join(root, ID, 'output.pdf'), 'file');
    setJob();
    const res = await get(`/compilations/${ID}/pdf`);
    expect(res.statusCode).toBe(410);
    expect(res.body).not.toContain('contenido-secreto');
  });
});

describe('POST /compilations: fallo a mitad de saveInputs', () => {
  async function startWithSaveError(error: Error): Promise<string[]> {
    await app.close();
    const real = createLocalCompilationsStorage(root);
    const removed: string[] = [];
    app = await buildApp({
      compilations: {
        queue,
        config: baseConfig(root),
        storage: {
          ...real,
          saveInputs: async () => {
            throw error;
          },
          remove: async (id) => {
            removed.push(id);
            await real.remove(id);
          },
        },
      },
    });
    return removed;
  }

  it('EEXIST (colisión que solo detecta el disco) → 400 duplicate_path y se borra lo escrito', async () => {
    const removed = await startWithSaveError(Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }));
    const res = await upload([{ name: 'main.tex' }]);
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json(), 'duplicate_path');
    expect(removed).toHaveLength(1);
    expect(queue.added).toEqual([]);
  });

  it('cualquier otro error → 500 y también se borra lo escrito', async () => {
    const removed = await startWithSaveError(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
    const res = await upload([{ name: 'main.tex' }]);
    expect(res.statusCode).toBe(500);
    expectErrorShape(res.json(), 'internal_error');
    expect(removed).toHaveLength(1);
  });
});
