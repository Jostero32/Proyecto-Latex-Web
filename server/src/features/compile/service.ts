// Compilar un proyecto: instantánea en S3, fila en `compilations` y job en la cola. El estado, los
// diagnósticos y los artefactos se leen del job y de S3, siempre con el permiso sobre el proyecto.
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  compilationArtifactKey,
  compilationInputPrefix,
  isUuid,
  isValidMainFile,
  type ArtifactKind,
  type Compilation,
} from '@latexweb/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db';
import { ApiError } from '../../http';
import { compilations, files, type Project } from '../../schema';
import { fileKey, type Storage } from '../../storage';
import type { ProjectDocs } from '../collab/documents';
import { assertProjectAccess } from '../projects/service';
import type { CompileQueue, JobSnapshot } from './queue';

export interface CompileConfig {
  /** Con más trabajos esperando, compilar responde 503. */
  maxQueued: number;
  /** Cuánto se conservan el job y los artefactos (la regla del bucket borra a 1 día). */
  ttlSeconds: number;
}

export interface CompileService {
  /** Encola la compilación del estado actual del proyecto (lo último editado, aunque no se haya guardado). */
  start(project: Project, userId: string): Promise<Compilation>;
  get(userId: string, compilationId: string): Promise<Compilation>;
  artifact(userId: string, compilationId: string, kind: ArtifactKind): Promise<Readable>;
}

export interface CompileDeps {
  db: Db;
  storage: Storage;
  docs: ProjectDocs;
  queue: CompileQueue;
  config: CompileConfig;
}

/** Subidas a S3 en paralelo al armar la instantánea. */
const SNAPSHOT_CONCURRENCY = 8;

export function createCompileService({ db, storage, docs, queue, config }: CompileDeps): CompileService {
  /** Fila y job de una compilación del usuario: 404 si no existe o no es miembro del proyecto. */
  async function load(userId: string, compilationId: string) {
    const [row] = isUuid(compilationId) ? await db.select().from(compilations).where(eq(compilations.id, compilationId)) : [];
    if (!row) throw new ApiError(404, 'not_found', 'La compilación no existe');
    await assertProjectAccess(db, userId, row.projectId, 'read');
    const job = await queue.get(row.id);
    if (!job) throw new ApiError(410, 'expired', 'La compilación venció');
    return { row, job };
  }

  return {
    async start(project, userId) {
      const rows = await db.select().from(files).where(eq(files.projectId, project.id));
      const main = rows.find((f) => f.path === project.mainFile);
      if (!main || main.kind !== 'text' || !isValidMainFile(project.mainFile)) {
        throw new ApiError(400, 'invalid_main_file', `El documento principal ${project.mainFile} no es un .tex del proyecto`);
      }
      if ((await queue.waitingCount()) >= config.maxQueued) {
        throw new ApiError(503, 'queue_full', 'Hay demasiadas compilaciones en espera; reintenta en unos segundos', { 'Retry-After': '10' });
      }

      const id = randomUUID();
      const prefix = compilationInputPrefix(id);
      const texts = await docs.read(project.id, (map) => new Map(rows.map((f) => [f.id, map.get(f.id)?.toString() ?? ''])));
      await inBatches(rows, SNAPSHOT_CONCURRENCY, (file) =>
        file.kind === 'text'
          ? storage.put(prefix + file.path, Buffer.from(texts.get(file.id) ?? '', 'utf8'))
          : storage.copy(fileKey(project.id, file.id), prefix + file.path),
      );
      const [row] = await db.insert(compilations).values({ id, projectId: project.id, userId }).returning();
      await queue.add({ compilationId: id, mainFile: project.mainFile, engine: project.engine });
      return toCompilation(id, project.id, {
        state: 'queued',
        data: { compilationId: id, mainFile: project.mainFile, engine: project.engine },
        createdAt: (row?.createdAt ?? new Date()).getTime(),
      }, config.ttlSeconds);
    },

    async get(userId, compilationId) {
      const { row, job } = await load(userId, compilationId);
      return toCompilation(row.id, row.projectId, job, config.ttlSeconds);
    },

    async artifact(userId, compilationId, kind) {
      const { row, job } = await load(userId, compilationId);
      const unavailable = artifactError(job, kind, config.ttlSeconds);
      if (unavailable) throw unavailable;
      const stream = await storage.get(compilationArtifactKey(row.id, kind));
      // La regla del bucket ya lo borró.
      if (!stream) throw new ApiError(410, 'expired', 'El archivo de la compilación venció');
      return stream;
    },
  };
}

export function toCompilation(id: string, projectId: string, job: JobSnapshot, ttlSeconds: number): Compilation {
  const compilation: Compilation = {
    id,
    projectId,
    // 'completed' sin resultado legible es transitorio (el resultado todavía no se pudo leer):
    // se informa 'running' para que el cliente siga esperando, nunca un 'failed' falso.
    status: job.state === 'completed' ? (job.result?.outcome ?? 'running') : job.state,
    engine: job.data.engine,
    mainFile: job.data.mainFile,
    createdAt: new Date(job.createdAt).toISOString(),
  };
  if (job.finishedAt !== undefined) {
    compilation.finishedAt = new Date(job.finishedAt).toISOString();
    compilation.expiresAt = new Date(job.finishedAt + ttlSeconds * 1000).toISOString();
  }
  const result = job.state === 'completed' ? job.result : undefined;
  if (result) {
    compilation.durationMs = result.durationMs;
    compilation.exitCode = result.exitCode;
    compilation.pdfMissingReason = result.pdfMissingReason;
    compilation.diagnostics = result.diagnostics;
    const base = `/api/compilations/${id}`;
    if (result.hasPdf) compilation.pdfUrl = `${base}/pdf`;
    if (result.hasLog) compilation.logUrl = `${base}/log`;
    if (result.hasSynctex) compilation.synctexUrl = `${base}/synctex`;
  }
  return compilation;
}

/** Por qué no se puede descargar un artefacto según el estado del job; null si se puede intentar. */
export function artifactError(job: JobSnapshot, kind: ArtifactKind, ttlSeconds: number, now = Date.now()): ApiError | null {
  // 'completed' sin resultado legible es transitorio: como si siguiera corriendo.
  if (job.state === 'queued' || job.state === 'running' || (job.state === 'completed' && !job.result)) {
    return new ApiError(409, 'not_ready', 'La compilación todavía no terminó');
  }
  const missing = new ApiError(404, 'artifact_not_available', 'La compilación no produjo ese archivo');
  // Un fallo de infraestructura no deja artefactos.
  if (job.state === 'failed' || !job.result) return missing;
  if (job.finishedAt !== undefined && now > job.finishedAt + ttlSeconds * 1000) {
    return new ApiError(410, 'expired', 'La compilación venció');
  }
  const { result } = job;
  if (kind === 'pdf' && !result.hasPdf) {
    return result.pdfMissingReason === 'too_large' ? new ApiError(404, 'pdf_too_large', 'El PDF superaba el tamaño máximo') : missing;
  }
  if ((kind === 'log' && !result.hasLog) || (kind === 'synctex' && !result.hasSynctex)) return missing;
  return null;
}

async function inBatches<T>(items: readonly T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}
