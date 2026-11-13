import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompileJobData } from '@latexweb/shared';
import { buildApp } from '../../app';
import type { CompilationsConfig } from '../../config';
import type { CompileQueue } from './compilations.queue';
import { createLocalCompilationsStorage } from './compilations.storage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MB = 1024 * 1024;

interface FakeQueue extends CompileQueue {
  added: CompileJobData[];
  waiting: number;
  failWaitingCount: boolean;
  failAdd: boolean;
}

function createFakeQueue(): FakeQueue {
  const queue: FakeQueue = {
    added: [],
    waiting: 0,
    failWaitingCount: false,
    failAdd: false,
    async add(data) {
      if (queue.failAdd) throw new Error('redis caído');
      queue.added.push(data);
    },
    async waitingCount() {
      if (queue.failWaitingCount) throw new Error('redis caído');
      return queue.waiting;
    },
    async get() {
      return null;
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
