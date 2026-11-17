// /api/compilations de punta a punta con una cola falsa y el disco real; y la cola de BullMQ contra
// Redis real. Esta API se reemplaza por la compilación de proyectos (docs/specs/backend.md, paso 4).
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CompileJobData, CompileJobResult } from '@latexweb/shared';
import { buildApp } from '../src/app';
import type { CompilationsConfig } from '../src/config';
import { createBullCompileQueue, type CompileQueue, type JobSnapshot } from '../src/features/compilations/queue';
import { buildStatusResponse } from '../src/features/compilations/status';
import { createLocalCompilationsStorage } from '../src/features/compilations/storage';

const MB = 1024 * 1024;
const ID = '3b241101-e2bb-4255-8caf-4136c566a962';

interface FakeQueue extends CompileQueue {
  added: CompileJobData[];
  waiting: number;
  jobs: Map<string, JobSnapshot>;
  getCalls: number;
}

function createFakeQueue(): FakeQueue {
  const queue: FakeQueue = {
    added: [],
    waiting: 0,
    jobs: new Map(),
    getCalls: 0,
    async add(data) {
      queue.added.push(data);
    },
    async waitingCount() {
      return queue.waiting;
    },
    async get(id) {
      queue.getCalls++;
      return queue.jobs.get(id) ?? null;
    },
    async close() {},
  };
  return queue;
}

let root: string;
let queue: FakeQueue;
let app: FastifyInstance;

async function start(upload = { maxFileBytes: 20 * MB, maxTotalBytes: 50 * MB, maxFiles: 200 }): Promise<void> {
  const config: CompilationsConfig = { storageDir: root, upload, maxQueued: 50, ttlSeconds: 3600, maxPdfBytes: 50 * MB };
  app = await buildApp({ compilations: { queue, storage: createLocalCompilationsStorage(root), config } });
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

async function upload(files: { name: string; content?: string }[], fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  for (const f of files) fd.append('files', new Blob([f.content ?? 'x']), f.name);
  const request = new Request('http://localhost/', { method: 'POST', body: fd });
  return app.inject({
    method: 'POST',
    url: '/api/compilations',
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { 'content-type': request.headers.get('content-type') ?? '' },
  });
}

function setJob(over: Partial<JobSnapshot> = {}): void {
  queue.jobs.set(ID, {
    state: 'completed',
    data: { compilationId: ID, mainFile: 'main.tex', engine: 'pdflatex' },
    createdAt: Date.now() - 5000,
    finishedAt: Date.now() - 1000,
    result: { outcome: 'success', exitCode: 0, durationMs: 1234, hasPdf: true, hasLog: true, pdfMissingReason: null },
    ...over,
  });
}

describe('POST /api/compilations', () => {
  it('guarda los archivos, ignora latexmkrc, detecta el motor y encola', async () => {
    const res = await upload([
      { name: 'main.tex', content: '% !TEX program = xelatex\nhola' },
      { name: 'figuras/a.png', content: 'PNG' },
      { name: 'latexmkrc' },
    ]);
    expect(res.statusCode).toBe(202);
    const body = res.json<{ id: string }>();
    expect(res.headers.location).toBe(`/api/compilations/${body.id}`);
    expect(body).toEqual({ id: body.id, status: 'queued', engine: 'xelatex', mainFile: 'main.tex', ignoredFiles: ['latexmkrc'] });
    const input = join(root, body.id, 'input');
    expect((await readdir(input)).sort()).toEqual(['figuras', 'main.tex']);
    expect(await readFile(join(input, 'figuras', 'a.png'), 'utf8')).toBe('PNG');
    expect(queue.added).toEqual([{ compilationId: body.id, mainFile: 'main.tex', engine: 'xelatex' }]);
  });

  it.each([
    ['ruta con ..', [{ name: 'main.tex' }, { name: '../x' }], {}, 'invalid_path'],
    ['duplicado por mayúsculas', [{ name: 'main.tex' }, { name: 'Main.tex' }], {}, 'duplicate_path'],
    ['sin el archivo principal', [{ name: 'otro.tex' }], {}, 'main_file_missing'],
    ['motor inválido', [{ name: 'main.tex' }], { engine: 'latex' }, 'invalid_engine'],
  ] as const)('%s → 400 %s sin escribir ni encolar', async (_label, files, fields, code) => {
    const res = await upload([...files], { ...fields });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: code, message: expect.any(String) });
    expect(queue.added).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('aplica los límites de tamaño y cantidad (413) sin escribir nada', async () => {
    await app.close();
    await start({ maxFileBytes: 100, maxTotalBytes: 150, maxFiles: 2 });
    expect((await upload([{ name: 'main.tex', content: 'a'.repeat(101) }])).json()).toMatchObject({ error: 'file_too_large' });
    expect((await upload([{ name: 'main.tex' }, { name: 'a.tex' }, { name: 'b.tex' }])).json()).toMatchObject({ error: 'too_many_files' });
    const total = await upload([
      { name: 'main.tex', content: 'a'.repeat(80) },
      { name: 'b.tex', content: 'b'.repeat(80) },
    ]);
    expect(total.statusCode).toBe(413);
    expect(await readdir(root)).toEqual([]);
  });

  it('con la cola llena responde 503 con Retry-After', async () => {
    queue.waiting = 50;
    const res = await upload([{ name: 'main.tex' }]);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
    expect(await readdir(root)).toEqual([]);
  });
});

describe('GET /api/compilations/:id', () => {
  it('estado de una compilación terminada, con las URLs de los artefactos', async () => {
    setJob();
    const res = await app.inject({ method: 'GET', url: `/api/compilations/${ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'success',
      pdfUrl: `/api/compilations/${ID}/pdf`,
      logUrl: `/api/compilations/${ID}/log`,
    });
  });

  it.each(['no-es-uuid', '..%2f..%2fetc'])('id inválido (%s) → 404 sin consultar la cola', async (bad) => {
    const res = await app.inject({ method: 'GET', url: `/api/compilations/${bad}/pdf` });
    expect(res.statusCode).toBe(404);
    expect(queue.getCalls).toBe(0);
  });

  it('sirve el PDF tal cual, con cabeceras que impiden interpretarlo como HTML', async () => {
    const content = Buffer.from('%PDF-\x00\xff<script>', 'latin1');
    await mkdir(join(root, ID), { recursive: true });
    await writeFile(join(root, ID, 'output.pdf'), content);
    setJob();
    const res = await app.inject({ method: 'GET', url: `/api/compilations/${ID}/pdf` });
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, content)).toBe(0);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('un artefacto pendiente da 409; uno vencido, 410', async () => {
    setJob({ state: 'running', finishedAt: undefined, result: undefined });
    expect((await app.inject({ method: 'GET', url: `/api/compilations/${ID}/pdf` })).statusCode).toBe(409);
    setJob({ finishedAt: Date.now() - 2 * 3600 * 1000 });
    expect((await app.inject({ method: 'GET', url: `/api/compilations/${ID}/pdf` })).statusCode).toBe(410);
  });
});

// Regresión de una carrera: get() leía el job y después su estado; si el job terminaba entre las dos
// lecturas, informaba 'completed' sin resultado y la API respondía un 'failed' falso.
describe('cola de BullMQ con Redis real', () => {
  const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const name = `compile-test-${randomUUID()}`;
  let connection: Redis;
  let workerConnection: Redis;
  let bull: CompileQueue;
  let worker: Worker<CompileJobData, CompileJobResult>;

  beforeAll(async () => {
    connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    workerConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    bull = createBullCompileQueue(connection, 3600, name);
    worker = new Worker<CompileJobData, CompileJobResult>(
      name,
      async () => ({ outcome: 'error', exitCode: 12, durationMs: 1, hasPdf: false, hasLog: true, pdfMissingReason: 'not_produced' }),
      { connection: workerConnection, concurrency: 4 },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    const raw = new Queue(name, { connection });
    await raw.obliterate({ force: true });
    await raw.close();
    await bull.close();
    connection.disconnect();
    workerConnection.disconnect();
  });

  it('mientras los jobs terminan, nunca informa completed sin resultado ni un failed falso', async () => {
    for (let i = 0; i < 40; i++) {
      const id = randomUUID();
      await bull.add({ compilationId: id, mainFile: 'main.tex', engine: 'pdflatex' });
      for (;;) {
        const job = await bull.get(id);
        expect(job).not.toBeNull();
        if (!job) break;
        if (job.state === 'completed') expect(job.result).toBeDefined();
        const status = buildStatusResponse(id, job, 3600).status;
        expect(status).not.toBe('failed');
        if (status === 'error') break;
      }
    }
  }, 60_000);
});
