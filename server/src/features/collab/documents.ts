// El texto de los proyectos: un Y.Doc por proyecto (`project:<id>`) con un Y.Map `files` que guarda un
// Y.Text por archivo de texto (clave: id del archivo). Hocuspocus lo carga y lo guarda en `documents`;
// la API REST lo lee y lo cambia por acá, así los editores conectados ven los cambios al instante.
import { Hocuspocus } from '@hocuspocus/server';
import { isUuid } from '@latexweb/shared';
import { eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import type { Db } from '../../db';
import { documents } from '../../schema';

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

/** Hocuspocus con persistencia en `documents` (sin db: en memoria, para tests de collab). */
export function createCollab(db?: Db): Hocuspocus {
  return new Hocuspocus({
    name: 'collab',
    quiet: true,
    debounce: 2_000,
    maxDebounce: 10_000,
    ...(db
      ? {
          async onLoadDocument({ document, documentName }) {
            const projectId = projectIdOf(documentName);
            if (!projectId) throw new Error(`documento inválido: ${documentName}`);
            const [row] = await db.select({ state: documents.state }).from(documents).where(eq(documents.projectId, projectId));
            if (row) Y.applyUpdate(document, row.state);
          },
          async onStoreDocument({ document, documentName }) {
            const projectId = projectIdOf(documentName);
            if (!projectId) return;
            const state = Y.encodeStateAsUpdate(document);
            // Si el proyecto se borró mientras el documento estaba abierto, no hay fila que guardar.
            await db.execute(sql`
              insert into documents (project_id, state, updated_at)
              select ${projectId}, ${Buffer.from(state)}, now()
              where exists (select 1 from projects where id = ${projectId})
              on conflict (project_id) do update set state = excluded.state, updated_at = now()`);
          },
        }
      : {}),
  });
}

export interface ProjectDocs {
  /** Lee el documento: el que está abierto en memoria (con lo último editado) o el guardado. */
  read<T>(projectId: string, fn: (files: Y.Map<Y.Text>) => T): Promise<T>;
  /** Cambia el documento en una transacción; queda guardado al volver. */
  change(projectId: string, fn: (files: Y.Map<Y.Text>) => void): Promise<void>;
}

export function createProjectDocs(hocuspocus: Hocuspocus, db: Db): ProjectDocs {
  return {
    async read(projectId, fn) {
      const open = hocuspocus.documents.get(projectDocName(projectId));
      if (open) return fn(filesMap(open));
      // Sin abrirlo en Hocuspocus: cerrar una conexión directa guarda el documento entero.
      const [row] = await db.select({ state: documents.state }).from(documents).where(eq(documents.projectId, projectId));
      const doc = new Y.Doc();
      try {
        if (row) Y.applyUpdate(doc, row.state);
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
  };
}

/** Reemplaza todo el contenido de un Y.Text. */
export function replaceText(text: Y.Text, content: string): void {
  if (text.length > 0) text.delete(0, text.length);
  if (content.length > 0) text.insert(0, content);
}
