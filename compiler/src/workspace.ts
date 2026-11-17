// Directorio de trabajo del worker (su propio volumen; no se comparte con el server).
//
//   <root>/<id>/input/**   instantánea del proyecto, bajada de MinIO (se monta en /in, solo lectura)
//   <root>/<id>/out/       montado en el contenedor como /out: output.pdf, .log, .synctex.gz y .blg
//
// Lo que deja la compilación viene del documento del usuario: no es confiable. Solo se leen archivos
// regulares (nunca symlinks) y con topes de tamaño.
import { constants, lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isCompilationId, isIgnoredPath, normalizeProjectPath } from '@latexweb/shared';
import { isSafeMountSource, type ContainerUser } from './docker';

export interface WorkspacePaths {
  /** Ruta absoluta del proyecto, para montar en /in (solo lectura). */
  inputDir: string;
  /** Ruta absoluta vacía y escribible por el usuario del contenedor, para montar en /out. */
  outputDir: string;
}

export interface Artifacts {
  pdf: Buffer | null;
  /** La compilación generó un PDF pero superaba maxPdfBytes. */
  pdfTooLarge: boolean;
  /** Completo o, si superaba maxLogBytes, su final con un aviso. */
  log: Buffer | null;
  synctex: Buffer | null;
  /** Log de biber o bibtex (solo para los diagnósticos). */
  blg: Buffer | null;
}

export interface SweepResult {
  removed: string[];
  /** Directorios vencidos que no se pudieron borrar (p. ej. EBUSY en Windows); se reintentan en el próximo barrido. */
  failed: string[];
}

export interface Workspace {
  /** Deja <id>/input y <id>/out vacíos (también en un reintento). */
  prepare(id: string): Promise<WorkspacePaths>;
  /** Escribe un archivo del proyecto en input/; la ruta se valida como cualquier ruta de proyecto. */
  writeInput(id: string, path: string, data: Buffer): Promise<void>;
  collectArtifacts(id: string): Promise<Artifacts>;
  /** Borra <id> entero. */
  cleanup(id: string): Promise<void>;
  sweepExpired(maxAgeMs: number, now?: number): Promise<SweepResult>;
}

export interface LocalWorkspaceOptions {
  /** Raíz de trabajo (COMPILE_WORK_DIR): absoluta y apta para --mount. */
  root: string;
  /** Un PDF (o un synctex) más grande no se publica. */
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
const OUTPUTS = { pdf: 'output.pdf', log: 'output.log', synctex: 'output.synctex.gz', blg: 'output.blg' } as const;
// O_NOFOLLOW no existe en Windows; ahí la defensa es el lstat previo.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function createLocalWorkspace(options: LocalWorkspaceOptions): Workspace {
  const { root, maxPdfBytes, maxLogBytes, containerUser } = options;
  const getuid = 'getuid' in options ? options.getuid : process.getuid;
  const chownDir = options.chownDir ?? chownDirNoFollow;

  if (!isSafeMountSource(root)) {
    throw new WorkspaceError(`raíz de trabajo inválida (debe ser absoluta y sin , " ni caracteres de control): ${root}`);
  }
  assertPositiveInteger(maxPdfBytes, 'maxPdfBytes');
  assertPositiveInteger(maxLogBytes, 'maxLogBytes');

  const jobDir = (id: string): string => {
    if (!isCompilationId(id)) throw new WorkspaceError(`id de compilación inválido: ${id}`);
    return join(root, id);
  };

  return {
    async prepare(id) {
      const dir = jobDir(id);
      await rm(dir, { recursive: true, force: true });
      const inputDir = join(dir, INPUT_DIR);
      const outputDir = join(dir, OUTPUT_DIR);
      await mkdir(inputDir, { recursive: true });
      await mkdir(outputDir);
      // Si el worker corre como root, el contenedor no (usa containerUser): /out tiene que ser suyo.
      if (getuid?.() === 0) await chownDir(outputDir, containerUser.uid, containerUser.gid);
      return { inputDir, outputDir };
    },

    async writeInput(id, rawPath, data) {
      const check = normalizeProjectPath(rawPath);
      if (!check.ok) throw new WorkspaceError(`ruta de entrada inválida (${check.reason}): ${rawPath}`);
      // latexmkrc se ejecutaría como Perl (aunque latexmk corre con -norc); los ocultos, por las dudas.
      if (isIgnoredPath(check.path)) return;
      const target = join(jobDir(id), INPUT_DIR, ...check.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      // wx: nunca sobrescribir (ni seguir un symlink que alguien haya dejado).
      await writeFile(target, data, { flag: 'wx' });
    },

    async collectArtifacts(id) {
      const out = join(jobDir(id), OUTPUT_DIR);
      const pdf = await readRegular(join(out, OUTPUTS.pdf), maxPdfBytes);
      const synctex = await readRegular(join(out, OUTPUTS.synctex), maxPdfBytes);
      return {
        pdf: pdf.data,
        pdfTooLarge: pdf.tooLarge,
        log: await readLog(join(out, OUTPUTS.log), maxLogBytes),
        synctex: synctex.data,
        blg: await readLog(join(out, OUTPUTS.blg), maxLogBytes),
      };
    },

    async cleanup(id) {
      await rm(jobDir(id), { recursive: true, force: true });
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

/** Lee un archivo regular de hasta `maxBytes` (sin seguir symlinks); si es más grande, tooLarge. */
async function readRegular(path: string, maxBytes: number): Promise<{ data: Buffer | null; tooLarge: boolean }> {
  const file = await openRegular(path);
  if (!file) return { data: null, tooLarge: false };
  try {
    if (file.size > maxBytes) return { data: null, tooLarge: true };
    return { data: await file.handle.readFile(), tooLarge: false };
  } finally {
    await file.handle.close();
  }
}

/** Lee un log; si supera `maxBytes`, solo su final con un aviso al principio. */
async function readLog(path: string, maxBytes: number): Promise<Buffer | null> {
  const file = await openRegular(path);
  if (!file) return null;
  try {
    if (file.size <= maxBytes) return await file.handle.readFile();
    const tail = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.handle.read(tail, 0, maxBytes, file.size - maxBytes);
    const notice = `[latexweb] El log original tenía ${file.size} bytes; se muestran los últimos ${bytesRead}.\n\n`;
    return Buffer.concat([Buffer.from(notice, 'utf8'), tail.subarray(0, bytesRead)]);
  } finally {
    await file.handle.close();
  }
}

/** Abre un archivo regular sin seguir symlinks; null si no existe o es otra cosa (symlink, directorio, FIFO…). */
async function openRegular(path: string) {
  const before = await lstatOrNull(path);
  if (before === null || !before.isFile()) return null;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOENT')) return null;
    throw error;
  }
  const stats = await handle.stat();
  if (!stats.isFile()) {
    await handle.close();
    return null;
  }
  return { handle, size: stats.size };
}

/**
 * Crea la raíz de trabajo si no existe (0700) y rechaza una raíz insegura. En Linux la raíz por
 * defecto está en /tmp, compartido entre usuarios: otro usuario podría crearla antes, o dejar un
 * symlink, y leer o redirigir todas las compilaciones. Dueño y modo solo se comprueban en POSIX.
 */
export async function prepareWorkRoot(
  root: string,
  getuid: (() => number) | undefined = process.getuid,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stats = await lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new WorkspaceError(`la raíz de trabajo no es un directorio real (¿symlink?): ${root}`);
  }
  if (process.platform === 'win32' || getuid === undefined) return;
  const uid = getuid();
  if (uid !== 0 && stats.uid !== uid) {
    throw new WorkspaceError(`la raíz de trabajo pertenece a otro usuario (uid ${stats.uid}): ${root}`);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new WorkspaceError(`la raíz de trabajo es escribible por otros usuarios: ${root}`);
  }
}

/**
 * chown de un directorio sin seguir symlinks: se abre con O_NOFOLLOW|O_DIRECTORY y se cambia el
 * dueño sobre el descriptor (fchown). Con chown(path), si alguien reemplaza el directorio por un
 * symlink entre el mkdir y el chown, un worker root cambiaría el dueño del destino.
 */
async function chownDirNoFollow(path: string, uid: number, gid: number): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | O_NOFOLLOW);
  try {
    await handle.chown(uid, gid);
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
