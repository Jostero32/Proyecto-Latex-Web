// Utilidades de los tests del server: la base latexweb_test (la crea global-setup.ts), el bucket de
// test en MinIO y una app con auth y proyectos.
import { sql } from 'drizzle-orm';
import yazl from 'yazl';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import { createDb, type Db } from '../src/db';
import { createAuthService, type AuthService } from '../src/features/auth/service';
import type { CompileQueue, JobSnapshot } from '../src/features/compile/queue';
import type { ProjectLimits } from '../src/features/files/service';
import type { CompileJobData } from '@latexweb/shared';
import { createStorage, type Storage } from '../src/storage';

export const ORIGIN = 'http://localhost:55173';
export const TEST_BUCKET = 'latexweb-test';

export function testDb(): Db {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL: los tests del server se corren con `pnpm test` (global-setup.ts)');
  return createDb(url);
}

export function testStorage(): Storage {
  return createStorage({
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:59000',
    region: 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY ?? 'latexweb',
    secretKey: process.env.S3_SECRET_KEY ?? 'latexweb-dev-secret',
    bucket: TEST_BUCKET,
  });
}

/** Vacía todas las tablas de la app. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE users, sessions, projects, compilations CASCADE`);
}

export const LIMITS: ProjectLimits = { maxBytes: 1024 * 1024, maxFiles: 20, fileMaxBytes: 512 * 1024, docMaxBytes: 256 * 1024 };

export interface Client {
  cookie: string;
  userId: string;
  request(options: InjectOptions): Promise<LightMyRequestResponse>;
  get(url: string): Promise<LightMyRequestResponse>;
  post(url: string, payload?: object): Promise<LightMyRequestResponse>;
  patch(url: string, payload: object): Promise<LightMyRequestResponse>;
  put(url: string, text: string): Promise<LightMyRequestResponse>;
  delete(url: string): Promise<LightMyRequestResponse>;
  /** Multipart: cada archivo con su ruta como filename, más campos de texto. */
  upload(url: string, files: Record<string, string | Buffer>, fields?: Record<string, string>): Promise<LightMyRequestResponse>;
}

export interface FakeQueue extends CompileQueue {
  added: CompileJobData[];
  waiting: number;
  jobs: Map<string, JobSnapshot>;
}

/** Cola de compilación en memoria: lo encolado queda en `added`; el estado de cada job se fija a mano. */
export function fakeQueue(): FakeQueue {
  const queue: FakeQueue = {
    added: [],
    waiting: 0,
    jobs: new Map(),
    async add(data) {
      queue.added.push(data);
      queue.jobs.set(data.compilationId, { state: 'queued', data, createdAt: Date.now() });
    },
    async waitingCount() {
      return queue.waiting;
    },
    async get(id) {
      return queue.jobs.get(id) ?? null;
    },
    async close() {},
  };
  return queue;
}

export interface ProjectsHarness {
  app: FastifyInstance;
  auth: AuthService;
  queue: FakeQueue;
  user(email: string): Promise<Client>;
}

export async function projectsApp(db: Db, storage: Storage, limits: ProjectLimits = LIMITS): Promise<ProjectsHarness> {
  const auth = createAuthService(db);
  const queue = fakeQueue();
  const app = await buildApp({
    auth: { service: auth, cookieSecure: false },
    projects: { db, storage, limits, queue, compile: { maxQueued: 5, ttlSeconds: 3600 } },
  });
  return {
    app,
    auth,
    queue,
    async user(email) {
      const session = await auth.register({ email, password: 'clave-larga-1', name: email.split('@')[0] });
      const cookie = `sid=${session.token}`;
      const request = (options: InjectOptions) =>
        app.inject({ ...options, headers: { cookie, origin: ORIGIN, ...(options.headers ?? {}) } });
      return {
        cookie,
        userId: session.user.id,
        request,
        get: (url) => request({ method: 'GET', url }),
        post: (url, payload) => request({ method: 'POST', url, ...(payload ? { payload } : {}) }),
        patch: (url, payload) => request({ method: 'PATCH', url, payload }),
        put: (url, text) => request({ method: 'PUT', url, payload: text, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
        delete: (url) => request({ method: 'DELETE', url }),
        async upload(url, files, fields = {}) {
          const form = new FormData();
          for (const [name, value] of Object.entries(fields)) form.append(name, value);
          for (const [path, content] of Object.entries(files)) form.append('file', new Blob([content]), path);
          const body = new Request('http://localhost/', { method: 'POST', body: form });
          return request({
            method: 'POST',
            url,
            payload: Buffer.from(await body.arrayBuffer()),
            headers: { 'content-type': body.headers.get('content-type') ?? '' },
          });
        },
      };
    },
  };
}

export interface ZipEntry {
  name: string;
  data?: string | Buffer;
  /** Modo Unix (p. ej. 0o120777 para un symlink). */
  mode?: number;
}

export function makeZip(entries: readonly ZipEntry[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data) : (entry.data ?? Buffer.from('x'));
    zip.addBuffer(data, entry.name, entry.mode === undefined ? {} : { mode: entry.mode });
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

/** Reemplaza un texto por otro del mismo largo en todo el zip (nombres en los encabezados). */
export function patchZip(zip: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error('mismo largo');
  const result = Buffer.from(zip);
  for (let i = result.indexOf(from); i !== -1; i = result.indexOf(from, i + 1)) result.write(to, i);
  return result;
}
