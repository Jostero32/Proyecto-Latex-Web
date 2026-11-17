// Processor de la cola `compile`: baja la instantánea del proyecto de MinIO, compila en Docker (sin
// red, sin shell-escape, con límites), sube los artefactos y devuelve el resultado con los
// diagnósticos del log.
//
// Un error de LaTeX (o un timeout) es un RESULTADO: el job termina en `completed` con su outcome.
// Solo se lanza una excepción ante fallos de infraestructura o un payload inválido, y el job queda
// en `failed`; el detalle va al log del worker, nunca a la API.
import {
  compilationArtifactKey,
  compilationInputPrefix,
  isCompilationId,
  isEngine,
  isValidMainFile,
  type CompileJobData,
  type CompileJobResult,
  type PdfMissingReason,
} from '@latexweb/shared';
import {
  buildDockerRunArgs,
  classifyRun,
  containerName,
  runContainer as defaultRunContainer,
  type ContainerUser,
  type RunContainerOptions,
  type RunContainerResult,
} from './docker';
import { finish, parseBlg, parseLatexLog } from './log';
import type { Storage } from './storage';
import type { Workspace } from './workspace';

export interface ProcessorDeps {
  workspace: Workspace;
  storage: Pick<Storage, 'list' | 'getBuffer' | 'put'>;
  containerUser: Readonly<ContainerUser>;
  image: string;
  timeoutSeconds: number;
  cpus: number;
  memory: string;
  pidsLimit: number;
  tmpfsSize: string;
  /** Tope por archivo de la compilación (--ulimit fsize). */
  maxFileBytes: number;
  /** Topes de la instantánea que se baja (el server ya los aplica; aquí es defensa en profundidad). */
  maxInputBytes: number;
  maxInputFiles: number;
  /** Modo volumen (docker compose): volumen con nombre que contiene la raíz de trabajo. */
  workVolume?: string | undefined;
  /** Si hay menos espacio libre, el job falla sin compilar. Sin esto no se comprueba. */
  minFreeBytes?: number | undefined;
  /** Bytes libres en la raíz de trabajo (por defecto no se consulta). */
  freeBytes?: () => Promise<number>;
  /** Inyectable para tests. */
  runContainer?: (options: RunContainerOptions) => Promise<RunContainerResult>;
  /** Registro de fallos de infraestructura (por defecto console.error). */
  logError?: (message: string) => void;
}

/** Mínimo de un job de BullMQ que usa el processor. */
export interface CompileJob {
  id?: string | undefined;
  data: unknown;
}

export class InvalidJobError extends Error {
  override name = 'InvalidJobError';
}

export class InfrastructureError extends Error {
  override name = 'InfrastructureError';
}

export function createCompileProcessor(deps: ProcessorDeps): (job: CompileJob) => Promise<CompileJobResult> {
  const run = deps.runContainer ?? defaultRunContainer;
  const logError = deps.logError ?? ((message: string) => console.error(message));

  async function download(id: string): Promise<void> {
    const prefix = compilationInputPrefix(id);
    const objects = await deps.storage.list(prefix);
    const total = objects.reduce((sum, o) => sum + o.size, 0);
    if (objects.length > deps.maxInputFiles || total > deps.maxInputBytes) {
      throw new InvalidJobError(`la instantánea supera los topes (${objects.length} archivos, ${total} bytes)`);
    }
    for (const object of objects) {
      await deps.workspace.writeInput(id, object.key.slice(prefix.length), await deps.storage.getBuffer(object.key));
    }
  }

  return async (job) => {
    // El worker vuelve a validar todo: no confía en lo que haya en Redis.
    const data = parseJobData(job.data);
    if (job.id !== undefined && job.id !== data.compilationId) {
      throw new InvalidJobError(`el id del job (${job.id}) no coincide con compilationId (${data.compilationId})`);
    }
    const { compilationId: id, engine, mainFile } = data;

    // Piso de espacio libre: no compilar con el disco casi lleno.
    if (deps.minFreeBytes !== undefined && deps.freeBytes !== undefined) {
      const free = await deps.freeBytes();
      if (free < deps.minFreeBytes) {
        logError(`[compiler] ${id}: espacio libre insuficiente (${free} < ${deps.minFreeBytes} bytes)`);
        throw new InfrastructureError('espacio libre insuficiente en el disco de trabajo');
      }
    }

    try {
      const paths = await deps.workspace.prepare(id);
      await download(id);
      const runResult = await run({
        containerName: containerName(id),
        timeoutSeconds: deps.timeoutSeconds,
        args: buildDockerRunArgs({
          compilationId: id,
          image: deps.image,
          engine,
          mainFile,
          ...paths,
          timeoutSeconds: deps.timeoutSeconds,
          cpus: deps.cpus,
          memory: deps.memory,
          pidsLimit: deps.pidsLimit,
          tmpfsSize: deps.tmpfsSize,
          maxFileBytes: deps.maxFileBytes,
          user: deps.containerUser,
          storageVolume: deps.workVolume,
        }),
      });

      const artifacts = await deps.workspace.collectArtifacts(id);
      const classification = classifyRun(runResult, artifacts.pdf !== null);
      if (classification.kind === 'infrastructure') {
        logError(`[compiler] ${id}: ${classification.reason}\n${runResult.stderrTail}`);
        throw new InfrastructureError(classification.reason);
      }

      if (artifacts.pdf) await deps.storage.put(compilationArtifactKey(id, 'pdf'), artifacts.pdf, 'application/pdf');
      if (artifacts.log) await deps.storage.put(compilationArtifactKey(id, 'log'), artifacts.log, 'text/plain; charset=utf-8');
      if (artifacts.synctex) await deps.storage.put(compilationArtifactKey(id, 'synctex'), artifacts.synctex, 'application/gzip');

      const pdfMissingReason: PdfMissingReason | null = artifacts.pdf
        ? null
        : artifacts.pdfTooLarge
          ? 'too_large'
          : 'not_produced';

      return {
        outcome: classification.outcome,
        exitCode: runResult.exitCode,
        durationMs: runResult.durationMs,
        hasPdf: artifacts.pdf !== null,
        hasLog: artifacts.log !== null,
        hasSynctex: artifacts.synctex !== null,
        pdfMissingReason,
        diagnostics: finish([
          ...parseLatexLog(artifacts.log?.toString('utf8') ?? ''),
          ...parseBlg(artifacts.blg?.toString('utf8') ?? ''),
        ]),
      };
    } finally {
      // Salió bien o mal, del trabajo local no queda nada: los artefactos ya están en MinIO.
      await deps.workspace.cleanup(id).catch((error: unknown) => {
        logError(`[compiler] ${id}: no se pudo limpiar el directorio de trabajo: ${String(error)}`);
      });
    }
  };
}

/** Valida el payload del job con los mismos criterios que la API. */
export function parseJobData(data: unknown): CompileJobData {
  if (typeof data !== 'object' || data === null) throw new InvalidJobError('payload del job inválido');
  const { compilationId, engine, mainFile } = data as Record<string, unknown>;
  if (typeof compilationId !== 'string' || !isCompilationId(compilationId)) {
    throw new InvalidJobError('compilationId inválido');
  }
  if (!isEngine(engine)) throw new InvalidJobError('motor inválido');
  if (typeof mainFile !== 'string' || !isValidMainFile(mainFile)) throw new InvalidJobError('documento principal inválido');
  return { compilationId, engine, mainFile };
}
