// Compilar proyectos de punta a punta sin el worker (cola falsa) contra Postgres y MinIO reales: la
// instantánea, el acceso por proyecto a la compilación y sus artefactos, y la cola de BullMQ real.
import { randomUUID } from 'node:crypto';
import {
  compilationArtifactKey,
  compilationInputPrefix,
  type Compilation,
  type CompileJobData,
  type CompileJobResult,
  type ProjectFile,
  type ProjectSummary,
} from '@latexweb/shared';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db';
import { createBullCompileQueue, type CompileQueue } from '../src/features/compile/queue';
import { toCompilation } from '../src/features/compile/service';
import { projectsApp, resetDb, testDb, testStorage, type Client, type ProjectsHarness } from './helpers';

const db = testDb();
const storage = testStorage();
afterAll(async () => {
  await closeDb(db);
  storage.close();
});

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const RESULT: CompileJobResult = {
  outcome: 'error',
  exitCode: 12,
  durationMs: 1500,
  hasPdf: true,
  hasLog: true,
  hasSynctex: true,
  pdfMissingReason: null,
  diagnostics: [{ file: 'main.tex', line: 3, level: 'error', message: 'Undefined control sequence.' }],
};

let harness: ProjectsHarness;
let owner: Client;
let project: ProjectSummary;

beforeEach(async () => {
  await resetDb(db);
  harness = await projectsApp(db, storage);
  owner = await harness.user('duena@ejemplo.com');
  project = (await owner.post('/api/projects', { name: 'Para compilar' })).json<{ project: ProjectSummary }>().project;
});
afterEach(() => harness.app.close());

async function compile(client: Client = owner): Promise<Compilation> {
  const res = await client.post(`/api/projects/${project.id}/compile`);
  expect(res.statusCode, res.body).toBe(202);
  const { compilation } = res.json<{ compilation: Compilation }>();
  expect(res.headers.location).toBe(`/api/compilations/${compilation.id}`);
  return compilation;
}

/** Simula que el worker terminó: resultado en el job y artefactos en MinIO. */
async function finish(id: string, result: CompileJobResult = RESULT) {
  const job = harness.queue.jobs.get(id);
  if (!job) throw new Error('sin job');
  harness.queue.jobs.set(id, { ...job, state: 'completed', result, finishedAt: Date.now() });
  await storage.put(compilationArtifactKey(id, 'pdf'), Buffer.from('%PDF-1.5 falso'));
  await storage.put(compilationArtifactKey(id, 'log'), Buffer.from('This is pdfTeX'));
  await storage.put(compilationArtifactKey(id, 'synctex'), Buffer.from([0x1f, 0x8b]));
}

describe('compilar un proyecto', () => {
  it('copia a MinIO el estado actual del proyecto (texto e imágenes) y encola con su documento y motor', async () => {
    const files = `/api/projects/${project.id}/files`;
    await owner.upload(files, { 'figuras/logo.png': PNG, 'capitulos/uno.tex': 'Uno' });
    const main = (await owner.get(files)).json<{ files: ProjectFile[] }>().files.find((f) => f.path === 'main.tex');
    await owner.put(`${files}/${main?.id}`, '\\documentclass{article}\\begin{document}Hola\\end{document}');
    await owner.patch(`/api/projects/${project.id}`, { engine: 'xelatex' });

    const compilation = await compile();
    expect(compilation).toMatchObject({ projectId: project.id, status: 'queued', engine: 'xelatex', mainFile: 'main.tex' });
    expect(harness.queue.added).toEqual([{ compilationId: compilation.id, mainFile: 'main.tex', engine: 'xelatex' }]);

    const input = compilationInputPrefix(compilation.id);
    expect((await storage.getBuffer(`${input}main.tex`))?.toString()).toContain('Hola');
    expect((await storage.getBuffer(`${input}capitulos/uno.tex`))?.toString()).toBe('Uno');
    expect(await storage.getBuffer(`${input}figuras/logo.png`)).toEqual(PNG);
  });

  it('estado con diagnósticos y descarga de PDF, log y SyncTeX', async () => {
    const { id } = await compile();
    const status = `/api/compilations/${id}`;
    expect((await owner.get(status)).json()).toMatchObject({ compilation: { status: 'queued' } });
    expect((await owner.get(`${status}/pdf`)).json()).toMatchObject({ error: 'not_ready' });

    await finish(id);
    expect((await owner.get(status)).json<{ compilation: Compilation }>().compilation).toMatchObject({
      status: 'error',
      diagnostics: RESULT.diagnostics,
      pdfUrl: `${status}/pdf`,
      logUrl: `${status}/log`,
      synctexUrl: `${status}/synctex`,
    });
    const pdf = await owner.get(`${status}/pdf`);
    expect(pdf.body).toBe('%PDF-1.5 falso');
    expect(pdf.headers).toMatchObject({ 'content-type': 'application/pdf', 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff' });
    expect((await owner.get(`${status}/log`)).body).toBe('This is pdfTeX');
    expect((await owner.get(`${status}/synctex`)).headers['content-type']).toBe('application/gzip');
    expect((await owner.get(`${status}/otro`)).statusCode).toBe(400);
  });

  it('un lector puede compilar; un ajeno recibe 404 en el proyecto, la compilación y sus artefactos', async () => {
    const viewer = await harness.user('lector@ejemplo.com');
    const { link } = (await owner.post(`/api/projects/${project.id}/share-links`, { role: 'viewer' })).json<{ link: { token: string } }>();
    await viewer.post(`/api/share/${link.token}/join`);
    const { id } = await compile(viewer);
    await finish(id);

    const stranger = await harness.user('ajena@ejemplo.com');
    expect((await stranger.post(`/api/projects/${project.id}/compile`)).statusCode).toBe(404);
    for (const path of ['', '/pdf', '/log', '/synctex']) {
      expect((await stranger.get(`/api/compilations/${id}${path}`)).statusCode).toBe(404);
    }
    expect((await owner.get(`/api/compilations/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('sin documento principal válido: 400; con la cola llena: 503 con Retry-After', async () => {
    const files = (await owner.get(`/api/projects/${project.id}/files`)).json<{ files: ProjectFile[] }>().files;
    await owner.delete(`/api/projects/${project.id}/files/${files[0]?.id}`);
    expect((await owner.post(`/api/projects/${project.id}/compile`)).json()).toMatchObject({ error: 'invalid_main_file' });

    await owner.upload(`/api/projects/${project.id}/files`, { 'main.tex': '\\documentclass{article}' });
    harness.queue.waiting = 5;
    const full = await owner.post(`/api/projects/${project.id}/compile`);
    expect([full.statusCode, full.json().error, full.headers['retry-after']]).toEqual([503, 'queue_full', '10']);
    expect(harness.queue.added).toEqual([]);
  });
});

describe('documentación de la API', () => {
  it('sirve OpenAPI con todas las rutas', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/api/projects', '/api/projects/{id}/files/{fileId}', '/api/projects/{id}/compile', '/api/compilations/{id}/{kind}', '/api/share/{token}/join']),
    );
    expect((await harness.app.inject({ method: 'GET', url: '/api/docs' })).statusCode).toBeLessThan(400);
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
    worker = new Worker<CompileJobData, CompileJobResult>(name, async () => ({ ...RESULT, hasPdf: false }), {
      connection: workerConnection,
      concurrency: 4,
    });
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
        const status = toCompilation(id, randomUUID(), job, 3600).status;
        expect(status).not.toBe('failed');
        if (status === 'error') break;
      }
    }
  }, 60_000);
});
