// El texto de los proyectos: un Y.Doc por proyecto (`project:<id>`) con un Y.Map `files` que guarda un
// Y.Text por archivo de texto (clave: id del archivo). Hocuspocus lo carga y lo guarda en `documents`;
// la API REST lo lee y lo cambia por acá, así los editores conectados ven los cambios al instante.
import type { Document, Hocuspocus } from '@hocuspocus/server';
import { isUuid } from '@latexweb/shared';
import { and, eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import type { Db } from '../../db';
import { documents, files, projects } from '../../schema';

const PREFIX = 'project:';

export const projectDocName = (projectId: string) => `${PREFIX}${projectId}`;

/** Id del proyecto de un nombre de documento, o null si no es `project:<uuid>`. */
export function projectIdOf(documentName: string): string | null {
  const id = documentName.startsWith(PREFIX) ? documentName.slice(PREFIX.length) : '';
  return isUuid(id) ? id : null;
}

export const filesMap = (doc: Y.Doc) => doc.getMap<Y.Text>('files');

/** Estado inicial de un proyecto nuevo (crear o importar), sin pasar por Hocuspocus. */
export function initialDocState(texts: ReadonlyMap<string, string>): Uint8Array {
  const doc = new Y.Doc();
  const map = filesMap(doc);
  doc.transact(() => {
    for (const [fileId, content] of texts) map.set(fileId, new Y.Text(content));
  });
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/** Reemplaza todo el contenido de un Y.Text. */
export function replaceText(text: Y.Text, content: string): void {
  if (text.length > 0) text.delete(0, text.length);
  if (content.length > 0) text.insert(0, content);
}

/** Carga el estado guardado en `document` (onLoadDocument). */
export async function loadDocument(db: Db, projectId: string, document: Y.Doc): Promise<void> {
  const [row] = await db.select({ state: documents.state }).from(documents).where(eq(documents.projectId, projectId));
  if (row) Y.applyUpdate(document, row.state);
}

/**
 * Guarda el documento (onStoreDocument) y pone al día el tamaño de los archivos de texto editados por
 * WebSocket, que cuentan para los topes del proyecto.
 */
export async function storeDocument(db: Db, projectId: string, document: Y.Doc): Promise<void> {
  const state = Y.encodeStateAsUpdate(document);
  // Si el proyecto se borró mientras el documento estaba abierto, no hay fila que guardar.
  await db.execute(sql`
    insert into documents (project_id, state, updated_at)
    select ${projectId}, ${Buffer.from(state)}, now()
    where exists (select 1 from projects where id = ${projectId})
    on conflict (project_id) do update set state = excluded.state, updated_at = now()`);

  const map = filesMap(document);
  const rows = await db
    .select({ id: files.id, size: files.size })
    .from(files)
    .where(and(eq(files.projectId, projectId), eq(files.kind, 'text')));
  const changed = rows.flatMap((row) => {
    const size = Buffer.byteLength(map.get(row.id)?.toString() ?? '', 'utf8');
    return size === row.size ? [] : [{ id: row.id, size }];
  });
  if (changed.length === 0) return;
  await db.transaction(async (tx) => {
    for (const { id, size } of changed) await tx.update(files).set({ size, updatedAt: new Date() }).where(eq(files.id, id));
    await tx.update(projects).set({ updatedAt: sql`now()` }).where(eq(projects.id, projectId));
  });
}

/** Mensajes sin estado a los editores conectados: la API cambió el árbol o los datos del proyecto. */
export type CollabNotice = 'files-changed' | 'project-changed';

/** Contexto de cada conexión de Hocuspocus (lo arma el upgrade con la sesión). */
export interface CollabContext {
  userId: string;
  /** Se vuelve a validar antes de procesar cada mensaje (logout y caducidad). */
  sessionToken?: string;
}

export interface ProjectDocs {
  /** Lee el documento: el que está abierto en memoria (con lo último editado) o el guardado. */
  read<T>(projectId: string, fn: (files: Y.Map<Y.Text>) => T): Promise<T>;
  /** Cambia el documento en una transacción; queda guardado al volver. */
  change(projectId: string, fn: (files: Y.Map<Y.Text>) => void): Promise<void>;
  notify(projectId: string, notice: CollabNotice): void;
  /**
   * Cierra las conexiones al proyecto (de un usuario, o todas). El cliente se reconecta y vuelve a
   * pasar por los permisos: así se aplica quitar a un miembro o bajarlo a lector.
   */
  disconnect(projectId: string, userId?: string): void;
}

export function createProjectDocs(hocuspocus: Hocuspocus, db: Db): ProjectDocs {
  const openDocument = (projectId: string): Document | undefined => hocuspocus.documents.get(projectDocName(projectId));
  return {
    async read(projectId, fn) {
      const open = openDocument(projectId);
      if (open) return fn(filesMap(open));
      // Sin abrirlo en Hocuspocus: cerrar una conexión directa guarda el documento entero.
      const doc = new Y.Doc();
      try {
        await loadDocument(db, projectId, doc);
        return fn(filesMap(doc));
      } finally {
        doc.destroy();
      }
    },
    async change(projectId, fn) {
      const connection = await hocuspocus.openDirectConnection(projectDocName(projectId));
      try {
        await connection.transact((doc) => fn(filesMap(doc)));
      } finally {
        await connection.disconnect();
      }
    },
    notify(projectId, notice) {
      openDocument(projectId)?.broadcastStateless(JSON.stringify({ type: notice }));
    },
    disconnect(projectId, userId) {
      for (const connection of openDocument(projectId)?.getConnections() ?? []) {
        const context = connection.context as Partial<CollabContext>;
        if (userId === undefined || context.userId === userId) {
          connection.close({ code: 4403, reason: 'permissions-changed' });
        }
      }
    },
  };
}
