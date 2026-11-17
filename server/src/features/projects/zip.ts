// Importar y exportar proyectos como zip (yauzl y yazl). Al importar, todo se valida con el
// directorio central ANTES de descomprimir nada: rutas, symlinks, cantidad de entradas y tamaños
// declarados. Al descomprimir se cuentan los bytes reales (yauzl además rechaza una entrada que
// produce más bytes de los que declara).
import type { Readable } from 'node:stream';
import { isIgnoredPath, normalizeProjectPath } from '@latexweb/shared';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import yazl from 'yazl';
import { ApiError } from '../../http';
import type { IncomingFile, ProjectLimits } from '../files/service';

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

const invalid = (message: string) => new ApiError(400, 'invalid_zip', message);

/** Lee los archivos de un zip, sin los ignorados (`__MACOSX/`, ocultos, `latexmkrc`). */
export async function readZip(buffer: Buffer, limits: ProjectLimits): Promise<IncomingFile[]> {
  const zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true })
    .catch((error: unknown) => {
      throw invalid(`No es un zip válido: ${error instanceof Error ? error.message : String(error)}`);
    });
  try {
    const entries = await listEntries(zip, limits);
    const strip = commonRoot(entries.map((e) => e.path));
    const result: IncomingFile[] = [];
    let total = 0;
    for (const { entry, path } of entries) {
      const data = await readEntry(zip, entry, limits.fileMaxBytes);
      total += data.length;
      if (total > limits.maxBytes) throw new ApiError(413, 'project_too_large', `El zip descomprimido supera ${limits.maxBytes} bytes`);
      result.push({ path: strip ? path.slice(strip.length) : path, data });
    }
    return result;
  } finally {
    zip.close();
  }
}

/** Recorre el directorio central y valida cada entrada; no descomprime nada. */
async function listEntries(zip: ZipFile, limits: ProjectLimits): Promise<{ entry: Entry; path: string }[]> {
  // Las entradas ignoradas (carpetas, __MACOSX) también cuestan: tope del total de entradas.
  const maxEntries = limits.maxFiles * 2 + 100;
  if (zip.entryCount > maxEntries) throw new ApiError(413, 'too_many_files', `El zip tiene más de ${maxEntries} entradas`);

  const files: { entry: Entry; path: string }[] = [];
  let declared = 0;
  await new Promise<void>((resolve, reject) => {
    zip.on('error', (error: Error) => reject(error instanceof ApiError ? error : invalid(error.message)));
    zip.on('end', () => resolve());
    zip.on('entry', (entry: Entry) => {
      try {
        const path = checkEntry(entry);
        if (path !== null) {
          declared += entry.uncompressedSize;
          if (entry.uncompressedSize > limits.fileMaxBytes) {
            throw new ApiError(413, 'file_too_large', `${path} supera ${limits.fileMaxBytes} bytes`);
          }
          if (declared > limits.maxBytes) throw new ApiError(413, 'project_too_large', `El zip descomprimido supera ${limits.maxBytes} bytes`);
          files.push({ entry, path });
          if (files.length > limits.maxFiles) throw new ApiError(413, 'too_many_files', `El zip tiene más de ${limits.maxFiles} archivos`);
        }
        zip.readEntry();
      } catch (error) {
        reject(error);
      }
    });
    zip.readEntry();
  });
  return files;
}

/** Ruta normalizada de un archivo, null si se ignora (carpeta, __MACOSX, oculto, latexmkrc); lanza si es inválida. */
function checkEntry(entry: Entry): string | null {
  const name = entry.fileName;
  const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
  if (name.startsWith('__MACOSX/')) return null;
  if (mode === S_IFLNK) throw invalid(`El zip contiene un enlace simbólico: ${name}`);
  if (name.endsWith('/') || mode === S_IFDIR) return null;
  if (entry.isEncrypted()) throw invalid(`El zip contiene un archivo cifrado: ${name}`);
  const check = normalizeProjectPath(name);
  if (!check.ok) throw invalid(`Ruta inválida en el zip (${check.reason}): ${name}`);
  return isIgnoredPath(check.path) ? null : check.path;
}

function readEntry(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(invalid(error.message));
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) stream.destroy(new ApiError(413, 'file_too_large', `${entry.fileName} supera ${maxBytes} bytes`));
        else chunks.push(chunk);
      });
      stream.on('error', (e: Error) => reject(e instanceof ApiError ? e : invalid(e.message)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

/** `proyecto/` si todos los archivos están dentro de esa única carpeta (zips de GitHub, de carpetas). */
function commonRoot(paths: readonly string[]): string | null {
  const first = paths[0]?.split('/')[0];
  if (first === undefined) return null;
  const root = `${first}/`;
  return paths.every((p) => p.startsWith(root)) ? root : null;
}

export interface ZipItem {
  path: string;
  /** Contenido en memoria (texto) o un stream que se abre al llegar su turno (binarios). */
  content: Buffer | (() => Promise<Readable>);
}

/** Arma el zip en streaming: los binarios se piden a S3 de a uno, cuando el zip llega a ellos. */
export function writeZip(items: readonly ZipItem[]): Readable {
  const zip = new yazl.ZipFile();
  for (const item of items) {
    const content = item.content;
    if (Buffer.isBuffer(content)) zip.addBuffer(content, item.path);
    else zip.addReadStreamLazy(item.path, (callback) => {
      content().then((stream) => callback(null, stream), (error: unknown) => callback(error, undefined as never));
    });
  }
  zip.end();
  return zip.outputStream as Readable;
}
