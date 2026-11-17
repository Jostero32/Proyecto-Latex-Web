// Processor de la cola `compile`. Ver docs/specs/compilacion.md, "Estados y resultado".
//
// Un error de LaTeX (o un timeout) es un RESULTADO: el job termina en `completed` con su outcome.
// Solo se lanza una excepción ante fallos de infraestructura o un payload inválido, y el job queda
// en `failed`; el detalle va al log del worker, nunca a la API.
import {
  isCompilationId,
  isEngine,
  isValidMainFile,
  type CompileJobData,
  type CompileJobResult,
  type PdfMissingReason,
} from '@latexweb/shared';
import { buildDockerRunArgs, containerName, type ContainerUser } from '../docker/docker-args';
import { classifyRun, runContainer as defaultRunContainer, type RunContainerOptions, type RunContainerResult } from '../docker/runner';
import type { Workspace } from '../workspace/workspace';

export interface ProcessorDeps {
  workspace: Workspace;
  containerUser: Readonly<ContainerUser>;
  image: string;
  timeoutSeconds: number;
  cpus: number;
  memory: string;
  pidsLimit: number;
  tmpfsSize: string;
  /** Tope por archivo de la compilación (--ulimit fsize). */
  maxFileBytes: number;
  /** Modo volumen (docker compose): volumen con nombre que contiene la raíz de almacenamiento. */
  storageVolume?: string | undefined;
  /** Si hay menos espacio libre, el job falla sin compilar. Sin esto no se comprueba. */
  minFreeBytes?: number | undefined;
  /** Bytes libres en la raíz de almacenamiento (por defecto no se consulta). */
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

  return async (job) => {
    // El worker vuelve a validar todo: no confía en lo que haya en Redis.
    const data = parseJobData(job.data);
    if (job.id !== undefined && job.id !== data.compilationId) {
      throw new InvalidJobError(`el id del job (${job.id}) no coincide con compilationId (${data.compilationId})`);
    }
    const { compilationId: id, engine, mainFile } = data;

    // Piso de espacio libre: no compilar (y no publicar hasta ~55 MB más) con el disco casi lleno.
    if (deps.minFreeBytes !== undefined && deps.freeBytes !== undefined) {
      const free = await deps.freeBytes();
      if (free < deps.minFreeBytes) {
        logError(`[compiler] ${id}: espacio libre insuficiente (${free} < ${deps.minFreeBytes} bytes)`);
        throw new InfrastructureError('espacio libre insuficiente en el almacenamiento');
      }
    }

    const paths = await deps.workspace.prepareInputs(id);
    try {
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
          storageVolume: deps.storageVolume,
        }),
      });

      const published = await deps.workspace.publishArtifacts(id);
      const classification = classifyRun(runResult, published.hasPdf);
      if (classification.kind === 'infrastructure') {
        logError(`[compiler] ${id}: ${classification.reason}\n${runResult.stderrTail}`);
        throw new InfrastructureError(classification.reason);
      }

      const pdfMissingReason: PdfMissingReason | null = published.hasPdf
        ? null
        : published.pdfTooLarge
          ? 'too_large'
          : 'not_produced';

      return {
        outcome: classification.outcome,
        exitCode: runResult.exitCode,
        durationMs: runResult.durationMs,
        hasPdf: published.hasPdf,
        hasLog: published.hasLog,
        pdfMissingReason,
      };
    } finally {
      // input/ y out/ ya no hacen falta, salió bien o mal: solo quedan los artefactos publicados.
      await deps.workspace.cleanupWork(id).catch((error: unknown) => {
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
