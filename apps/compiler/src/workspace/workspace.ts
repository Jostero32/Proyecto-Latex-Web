// Directorios de trabajo de las compilaciones en el disco compartido con la API.
// Ver docs/specs/compilacion.md, sección "Almacenamiento (directorio compartido)".
//
//   <root>/<id>/input/**         archivos del proyecto (los escribe la API)
//   <root>/<id>/out/             montado en el contenedor como /out
//   <root>/<id>/output.pdf|log   artefactos publicados por el worker (los sirve la API)
//
// Cuando se reemplace por MinIO, solo cambia esta implementación: el processor usa la interfaz.
import { chown, constants, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTIFACT_FILES, isCompilationId } from '@latexweb/shared';
import { isSafeMountSource, type ContainerUser } from '../docker/docker-args';

export interface WorkspacePaths {
  /** Ruta absoluta del proyecto, para montar en /in (solo lectura). */
  inputDir: string;
  /** Ruta absoluta vacía y escribible por el usuario del contenedor, para montar en /out. */
  outputDir: string;
}

export interface PublishResult {
  hasPdf: boolean;
  hasLog: boolean;
  /** El log superó el máximo y se publicó solo su final. */
  logTruncated: boolean;
}

export interface SweepResult {
  removed: string[];
  /** Directorios vencidos que no se pudieron borrar (p. ej. EBUSY en Windows); se reintentan en el próximo barrido. */
  failed: string[];
}

export interface Workspace {
  prepareInputs(id: string): Promise<WorkspacePaths>;
  publishArtifacts(id: string): Promise<PublishResult>;
  cleanupWork(id: string): Promise<void>;
  sweepExpired(maxAgeMs: number, now?: number): Promise<SweepResult>;
}

export interface LocalWorkspaceOptions {
  /** Raíz de almacenamiento (COMPILE_STORAGE_DIR): absoluta y apta para --mount. */
  root: string;
  /** Un PDF más grande no se publica. */
  maxPdfBytes: number;
  /** Un log más grande se publica truncado a sus últimos `maxLogBytes`. */
  maxLogBytes: number;
  /** Usuario con el que corre el contenedor (ver resolveContainerUser). */
  containerUser: Readonly<ContainerUser>;
  /** Inyectables para tests. */
  getuid?: (() => number) | undefined;
  chownDir?: (path: string, uid: number, gid: number) => Promise<void>;
}

export class WorkspaceError extends Error {
  override name = 'WorkspaceError';
}

const INPUT_DIR = 'input';
const OUTPUT_DIR = 'out';
// O_NOFOLLOW no existe en Windows; ahí la defensa es el lstat previo.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function createLocalWorkspace(options: LocalWorkspaceOptions): Workspace {
  const { root, maxPdfBytes, maxLogBytes, containerUser } = options;
  const getuid = 'getuid' in options ? options.getuid : process.getuid;
  const chownDir = options.chownDir ?? chown;

  if (!isSafeMountSource(root)) {
    throw new WorkspaceError(`raíz de almacenamiento inválida (debe ser absoluta y sin , " ni caracteres de control): ${root}`);
  }
  assertPositiveInteger(maxPdfBytes, 'maxPdfBytes');
  assertPositiveInteger(maxLogBytes, 'maxLogBytes');

  const jobDir = (id: string): string => {
    if (!isCompilationId(id)) throw new WorkspaceError(`id de compilación inválido: ${id}`);
    return join(root, id);
  };

  return {
    async prepareInputs(id) {
      const dir = jobDir(id);
      const inputDir = join(dir, INPUT_DIR);
      const outputDir = join(dir, OUTPUT_DIR);

      const input = await lstatOrNull(inputDir);
      if (input === null || !input.isDirectory()) {
        throw new WorkspaceError(`no existe el directorio de entrada de ${id}`);
      }

      // Si es un reintento (el worker se cayó a mitad), se descarta lo que haya quedado.
      await rm(outputDir, { recursive: true, force: true });
      await Promise.all(Object.values(ARTIFACT_FILES).map((file) => rm(join(dir, file), { force: true })));
      await mkdir(outputDir);

      // Si el worker corre como root, el contenedor no (usa containerUser): /out tiene que ser suyo.
      if (getuid?.() === 0) await chownDir(outputDir, containerUser.uid, containerUser.gid);

      return { inputDir, outputDir };
    },

    async publishArtifacts(id) {
      const dir = jobDir(id);
      const outputDir = join(dir, OUTPUT_DIR);

      const hasPdf = await publishIfSafe(join(outputDir, ARTIFACT_FILES.pdf), join(dir, ARTIFACT_FILES.pdf), maxPdfBytes);

      const logSource = join(outputDir, ARTIFACT_FILES.log);
      const logTarget = join(dir, ARTIFACT_FILES.log);
      let hasLog = await publishIfSafe(logSource, logTarget, maxLogBytes);
      let logTruncated = false;
      if (!hasLog) {
        logTruncated = await publishLogTail(logSource, logTarget, maxLogBytes);
        hasLog = logTruncated;
      }

      return { hasPdf, hasLog, logTruncated };
    },

    async cleanupWork(id) {
      const dir = jobDir(id);
      await rm(join(dir, INPUT_DIR), { recursive: true, force: true });
      await rm(join(dir, OUTPUT_DIR), { recursive: true, force: true });
    },

    async sweepExpired(maxAgeMs, now = Date.now()) {
      if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new WorkspaceError(`maxAgeMs inválido: ${maxAgeMs}`);
      const result: SweepResult = { removed: [], failed: [] };

      let names: string[];
      try {
        names = await readdir(root);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return result;
        throw error;
      }

      for (const name of names) {
        // Solo directorios de compilaciones: nunca otra cosa que alguien haya puesto en la raíz.
        if (!isCompilationId(name)) continue;
        const path = join(root, name);
        const stats = await lstatOrNull(path);
        if (stats === null || !stats.isDirectory()) continue;
        // El mtime del directorio cambia al publicar y al limpiar: aproxima el fin de la compilación.
        if (now - stats.mtimeMs <= maxAgeMs) continue;
        try {
          await rm(path, { recursive: true, force: true });
          result.removed.push(name);
        } catch {
          result.failed.push(name);
        }
      }

      return result;
    },
  };
}

/**
 * Publica `source` en `target` con un rename atómico si es un archivo regular (no symlink,
 * no directorio, etc.) de como máximo `maxBytes`. El contenido viene de la compilación del
 * usuario: no es confiable. Devuelve si se publicó.
 */
async function publishIfSafe(source: string, target: string, maxBytes: number): Promise<boolean> {
  const stats = await regularFileStats(source);
  if (stats === null || stats.size > maxBytes) return false;
  await rename(source, target);
  return true;
}

/** Publica los últimos `maxBytes` del log con un aviso al principio. Devuelve si se publicó. */
async function publishLogTail(source: string, target: string, maxBytes: number): Promise<boolean> {
  const stats = await regularFileStats(source);
  if (stats === null) return false;

  const handle = await open(source, constants.O_RDONLY | O_NOFOLLOW);
  let tail: Buffer;
  try {
    tail = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(tail, 0, maxBytes, Math.max(0, stats.size - maxBytes));
    tail = tail.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  const notice = `[latexweb] El log original tenía ${stats.size} bytes; se muestran los últimos ${tail.length}.\n\n`;
  const temporary = `${target}.tmp`;
  await writeFile(temporary, Buffer.concat([Buffer.from(notice, 'utf8'), tail]));
  await rename(temporary, target);
  return true;
}

/** Stats de un archivo regular, o null si no existe o es otra cosa (symlink, directorio, FIFO…). */
async function regularFileStats(path: string): Promise<{ size: number } | null> {
  const before = await lstatOrNull(path);
  if (before === null || !before.isFile()) return null;
  // Abrir sin seguir symlinks y volver a comprobar sobre el descriptor.
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOENT')) return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    return stats.isFile() ? { size: stats.size } : null;
  } finally {
    await handle.close();
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new WorkspaceError(`${label} inválido: ${value}`);
}
