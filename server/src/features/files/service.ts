// Archivos de un proyecto. El árbol (rutas, tipo, tamaño) está en `files`; el texto, en el Y.Doc del
// proyecto (collab/documents.ts); los binarios, en S3. Orden de escritura: primero el contenido y después
// la fila; al borrar, primero la fila. Un fallo deja contenido huérfano, nunca una fila sin contenido.
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { findPathCollision, isIgnoredPath, isUuid, normalizeProjectPath, pathKey, type ProjectFile } from '@latexweb/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import type { Db } from '../../db';
import { isUniqueViolation } from '../../db';
import { ApiError } from '../../http';
import { files, projects, type FileRow, type Project } from '../../schema';
import { fileKey, type Storage } from '../../storage';
import { replaceText, type ProjectDocs } from '../collab/documents';

export interface ProjectLimits {
  /** Suma de los tamaños de los archivos de un proyecto. */
  maxBytes: number;
  maxFiles: number;
  /** Tamaño máximo de un archivo. */
  fileMaxBytes: number;
  /** Suma de los archivos de texto: es el documento de colaboración, que vive en memoria al editarlo. */
  docMaxBytes: number;
}

export interface IncomingFile {
  path: string;
  data: Buffer;
}

/** Archivo validado y clasificado, listo para escribir. */
export interface PreparedFile {
  id: string;
  path: string;
  pathKey: string;
  kind: 'text' | 'binary';
  size: number;
  data: Buffer;
  /** Solo en los de texto. */
  text?: string;
}

// Extensiones que se editan como texto (si además son UTF-8 válido). El resto, binario.
const TEXT_EXTENSIONS = new Set([
  'tex', 'ltx', 'bib', 'bst', 'bbx', 'cbx', 'lbx', 'cls', 'sty', 'dtx', 'ins', 'def', 'cfg', 'clo', 'fd',
  'tikz', 'pgf', 'asy', 'gnuplot', 'txt', 'md', 'csv', 'tsv', 'dat', 'json', 'yaml', 'yml', 'xml',
]);

const INLINE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const ATTACHMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  eps: 'application/postscript',
  svg: 'image/svg+xml',
};

const extensionOf = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';

/** Content-Type y disposición de un binario: las imágenes se muestran; el resto se descarga. */
export function binaryContentType(path: string): { type: string; inline: boolean } {
  const ext = extensionOf(path);
  const inline = INLINE_TYPES[ext];
  if (inline) return { type: inline, inline: true };
  return { type: ATTACHMENT_TYPES[ext] ?? 'application/octet-stream', inline: false };
}

/** Texto si la extensión es de texto y el contenido es UTF-8 válido (sin el BOM). */
export function decodeText(path: string, data: Buffer): string | null {
  if (!TEXT_EXTENSIONS.has(extensionOf(path))) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/** Valida una ruta nueva: normalizada, y ni oculta ni `latexmkrc` (latexmk lo ejecutaría). */
export function checkNewPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError(400, 'invalid_path', 'Falta la ruta');
  const check = normalizeProjectPath(raw);
  if (!check.ok) throw new ApiError(400, 'invalid_path', `Ruta inválida (${check.reason}): ${raw}`);
  if (isIgnoredPath(check.path)) throw new ApiError(400, 'invalid_path', `No se admiten archivos ocultos ni latexmkrc: ${raw}`);
  return check.path;
}

interface ExistingFile {
  id: string;
  path: string;
  pathKey: string;
  kind: 'text' | 'binary';
  size: number;
}

/**
 * Valida y clasifica archivos nuevos o de reemplazo contra lo que ya hay: rutas, colisiones (también
 * archivo contra carpeta) y topes. Un archivo con la ruta (sin distinguir mayúsculas) de uno existente
 * lo reemplaza y conserva su id.
 */
export function prepareFiles(incoming: readonly IncomingFile[], existing: readonly ExistingFile[], limits: ProjectLimits): PreparedFile[] {
  const byKey = new Map(existing.map((f) => [f.pathKey, f]));
  const prepared = incoming.map((file): PreparedFile => {
    const path = checkNewPath(file.path);
    const key = pathKey(path);
    if (file.data.length > limits.fileMaxBytes) {
      throw new ApiError(413, 'file_too_large', `${path} supera el máximo de ${limits.fileMaxBytes} bytes por archivo`);
    }
    const text = decodeText(path, file.data);
    const previous = byKey.get(key);
    return {
      id: previous?.id ?? randomUUID(),
      path: previous?.path ?? path,
      pathKey: key,
      kind: text === null ? 'binary' : 'text',
      size: file.data.length,
      data: file.data,
      ...(text === null ? {} : { text }),
    };
  });

  const replaced = new Set(prepared.map((f) => f.pathKey));
  const kept = existing.filter((f) => !replaced.has(f.pathKey));
  const collision = findPathCollision([...kept.map((f) => f.path), ...prepared.map((f) => f.path)]);
  if (collision) {
    throw new ApiError(409, 'path_conflict', `${collision.path} choca con ${collision.conflictsWith}`);
  }
  if (kept.length + prepared.length > limits.maxFiles) {
    throw new ApiError(413, 'too_many_files', `Un proyecto tiene como máximo ${limits.maxFiles} archivos`);
  }
  const all = [...kept, ...prepared];
  if (sumSizes(all) > limits.maxBytes) {
    throw new ApiError(413, 'project_too_large', `Un proyecto ocupa como máximo ${limits.maxBytes} bytes`);
  }
  checkTextTotal(all, limits);
  return prepared;
}

const sumSizes = (list: readonly { size: number }[]) => list.reduce((sum, f) => sum + f.size, 0);

function checkTextTotal(list: readonly { kind: string; size: number }[], limits: ProjectLimits): void {
  if (sumSizes(list.filter((f) => f.kind === 'text')) > limits.docMaxBytes) {
    throw new ApiError(413, 'document_too_large', `El texto de un proyecto ocupa como máximo ${limits.docMaxBytes} bytes`);
  }
}

export function toProjectFile(row: FileRow): ProjectFile {
  return { id: row.id, path: row.path, kind: row.kind, size: row.size, updatedAt: row.updatedAt.toISOString() };
}

export type FileContent = { file: FileRow; text: string } | { file: FileRow; stream: Readable };

export interface FilesService {
  list(projectId: string): Promise<ProjectFile[]>;
  upload(projectId: string, incoming: IncomingFile[]): Promise<ProjectFile[]>;
  read(projectId: string, fileId: string): Promise<FileContent>;
  writeText(projectId: string, fileId: string, content: string): Promise<ProjectFile>;
  rename(project: Project, fileId: string, rawPath: unknown): Promise<ProjectFile>;
  remove(projectId: string, fileId: string): Promise<void>;
  /** Sube los binarios de archivos nuevos (antes de insertar sus filas). */
  putBinaries(projectId: string, prepared: readonly PreparedFile[]): Promise<void>;
}

export interface FilesDeps {
  db: Db;
  storage: Storage;
  docs: ProjectDocs;
  limits: ProjectLimits;
}

export function createFilesService({ db, storage, docs, limits }: FilesDeps): FilesService {
  const touchProject = (projectId: string) =>
    db.update(projects).set({ updatedAt: sql`now()` }).where(eq(projects.id, projectId));

  async function getRow(projectId: string, fileId: string): Promise<FileRow> {
    const row = isUuid(fileId)
      ? (await db.select().from(files).where(and(eq(files.projectId, projectId), eq(files.id, fileId))))[0]
      : undefined;
    if (!row) throw new ApiError(404, 'not_found', 'El archivo no existe');
    return row;
  }

  async function existingFiles(projectId: string): Promise<ExistingFile[]> {
    return db
      .select({ id: files.id, path: files.path, pathKey: files.pathKey, kind: files.kind, size: files.size })
      .from(files)
      .where(eq(files.projectId, projectId));
  }

  const service: FilesService = {
    async list(projectId) {
      const rows = await db.select().from(files).where(eq(files.projectId, projectId)).orderBy(asc(files.path));
      return rows.map(toProjectFile);
    },

    async putBinaries(projectId, prepared) {
      for (const file of prepared) if (file.kind === 'binary') await storage.put(fileKey(projectId, file.id), file.data);
    },

    async upload(projectId, incoming) {
      const existing = await existingFiles(projectId);
      const prepared = prepareFiles(incoming, existing, limits);
      const previous = new Map(existing.map((f) => [f.id, f]));

      await service.putBinaries(projectId, prepared);
      await docs.change(projectId, (map) => {
        for (const file of prepared) {
          const current = map.get(file.id);
          if (file.text === undefined) map.delete(file.id);
          else if (current) replaceText(current, file.text);
          else map.set(file.id, new Y.Text(file.text));
        }
      });
      try {
        await db.transaction(async (tx) => {
          for (const file of prepared) {
            const values = { kind: file.kind, size: file.size, updatedAt: new Date() };
            if (previous.has(file.id)) await tx.update(files).set(values).where(eq(files.id, file.id));
            else await tx.insert(files).values({ id: file.id, projectId, path: file.path, pathKey: file.pathKey, ...values });
          }
          await tx.update(projects).set({ updatedAt: sql`now()` }).where(eq(projects.id, projectId));
        });
      } catch (error) {
        // Otra subida creó la misma ruta a la vez.
        if (isUniqueViolation(error)) throw new ApiError(409, 'path_conflict', 'Otro archivo con esa ruta se creó a la vez');
        throw error;
      }
      // Binarios que pasaron a ser texto: el objeto ya no se usa.
      const stale = prepared.filter((f) => f.kind === 'text' && previous.get(f.id)?.kind === 'binary');
      await storage.delete(stale.map((f) => fileKey(projectId, f.id)));

      docs.notify(projectId, 'files-changed');
      const ids = new Set(prepared.map((f) => f.id));
      return (await service.list(projectId)).filter((f) => ids.has(f.id));
    },

    async read(projectId, fileId) {
      const file = await getRow(projectId, fileId);
      if (file.kind === 'text') {
        return { file, text: await docs.read(projectId, (map) => map.get(file.id)?.toString() ?? '') };
      }
      const stream = await storage.get(fileKey(projectId, file.id));
      if (!stream) throw new ApiError(404, 'not_found', 'El contenido del archivo no existe');
      return { file, stream };
    },

    async writeText(projectId, fileId, content) {
      const file = await getRow(projectId, fileId);
      if (file.kind !== 'text') throw new ApiError(400, 'not_text', 'Solo se puede escribir un archivo de texto');
      const size = Buffer.byteLength(content, 'utf8');
      if (size > limits.fileMaxBytes) {
        throw new ApiError(413, 'file_too_large', `El archivo supera el máximo de ${limits.fileMaxBytes} bytes`);
      }
      const all = [...(await existingFiles(projectId)).filter((f) => f.id !== file.id), { kind: 'text', size }];
      if (sumSizes(all) > limits.maxBytes) {
        throw new ApiError(413, 'project_too_large', `Un proyecto ocupa como máximo ${limits.maxBytes} bytes`);
      }
      checkTextTotal(all, limits);
      await docs.change(projectId, (map) => {
        const text = map.get(file.id);
        if (text) replaceText(text, content);
        else map.set(file.id, new Y.Text(content));
      });
      const [row] = await db.update(files).set({ size, updatedAt: new Date() }).where(eq(files.id, file.id)).returning();
      await touchProject(projectId);
      return toProjectFile(row ?? file);
    },

    async rename(project, fileId, rawPath) {
      const file = await getRow(project.id, fileId);
      const path = checkNewPath(rawPath);
      const others = (await existingFiles(project.id)).filter((f) => f.id !== file.id);
      const collision = findPathCollision([...others.map((f) => f.path), path]);
      if (collision) throw new ApiError(409, 'path_conflict', `${collision.path} choca con ${collision.conflictsWith}`);
      try {
        const row = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(files)
            .set({ path, pathKey: pathKey(path), updatedAt: new Date() })
            .where(eq(files.id, file.id))
            .returning();
          // El documento principal sigue al archivo.
          const main = project.mainFile === file.path ? { mainFile: path } : {};
          await tx.update(projects).set({ ...main, updatedAt: sql`now()` }).where(eq(projects.id, project.id));
          return updated;
        });
        docs.notify(project.id, 'files-changed');
        if (project.mainFile === file.path) docs.notify(project.id, 'project-changed');
        return toProjectFile(row ?? file);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiError(409, 'path_conflict', 'Ya existe un archivo con esa ruta');
        throw error;
      }
    },

    async remove(projectId, fileId) {
      const file = await getRow(projectId, fileId);
      await db.delete(files).where(eq(files.id, file.id));
      await touchProject(projectId);
      if (file.kind === 'text') await docs.change(projectId, (map) => map.delete(file.id));
      else await storage.delete([fileKey(projectId, file.id)]);
      docs.notify(projectId, 'files-changed');
    },
  };
  return service;
}
