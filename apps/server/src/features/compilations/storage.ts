// Almacenamiento de las compilaciones del lado de la API, en el directorio compartido con el worker.
// Ver docs/specs/compilacion.md, "Almacenamiento (directorio compartido)". Cuando se pase a MinIO,
// solo cambia esta implementación.
import type { ReadStream } from 'node:fs';
import { constants, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { ARTIFACT_FILES, isCompilationId, type ArtifactKind } from '@latexweb/shared';

export interface ProjectFile {
  /** Ruta relativa POSIX ya validada con normalizeProjectPath. */
  path: string;
  data: Buffer;
}

export interface OpenedArtifact {
  stream: ReadStream;
  size: number;
}

export interface CompilationsStorage {
  saveInputs(id: string, files: readonly ProjectFile[]): Promise<void>;
  /** null si el artefacto no existe (nunca se publicó o ya se borró). */
  openArtifact(id: string, kind: ArtifactKind): Promise<OpenedArtifact | null>;
  remove(id: string): Promise<void>;
}

export class StorageError extends Error {
  override name = 'StorageError';
}

// O_NOFOLLOW no existe en Windows; ahí la defensa es el lstat previo.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function createLocalCompilationsStorage(root: string): CompilationsStorage {
  const jobDir = (id: string): string => {
    if (!isCompilationId(id)) throw new StorageError(`id de compilación inválido: ${id}`);
    return join(root, id);
  };

  return {
    async saveInputs(id, files) {
      const inputDir = join(jobDir(id), 'input');
      await mkdir(inputDir, { recursive: true });
      for (const file of files) {
        const target = join(inputDir, ...file.path.split('/'));
        // Defensa en profundidad: las rutas ya vienen validadas, pero nunca se escribe fuera de input/.
        const rel = relative(inputDir, target);
        if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
          throw new StorageError(`ruta fuera del proyecto: ${file.path}`);
        }
        await mkdir(dirname(target), { recursive: true });
        // 'wx': falla si ya existe; las colisiones se rechazan antes, esto es un seguro.
        await writeFile(target, file.data, { flag: 'wx' });
      }
    },

    async openArtifact(id, kind) {
      const path = join(jobDir(id), ARTIFACT_FILES[kind]);
      try {
        const stats = await lstat(path);
        if (!stats.isFile()) return null;
        const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
        const fdStats = await handle.stat();
        if (!fdStats.isFile()) {
          await handle.close();
          return null;
        }
        // El stream del propio handle es dueño del descriptor y lo cierra al terminar. Usar
        // createReadStream({ fd: handle.fd }) deja dos dueños: al recolectar el handle, Node intenta
        // cerrar un fd ya cerrado y lanza EBADF como excepción no capturada (tumba el proceso).
        return { stream: handle.createReadStream({ autoClose: true }), size: fdStats.size };
      } catch (error) {
        if (isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) return null;
        throw error;
      }
    },

    async remove(id) {
      await rm(jobDir(id), { recursive: true, force: true });
    },
  };
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
