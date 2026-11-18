// Proyectos: permisos (assertProjectAccess), crear, importar, listar, cambiar, borrar y exportar.
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DEFAULT_MAIN_FILE,
  detectEngineFromSource,
  ENGINES,
  higherRole,
  isUuid,
  isValidMainFile,
  ROLE_RANK,
  type Engine,
  type ProjectRole,
  type ProjectSummary,
  type UpdateProjectRequest,
} from '@latexweb/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db';
import { ApiError } from '../../http';
import { documents, files, projectMembers, projects, type Project } from '../../schema';
import { fileKey, projectPrefix, type Storage } from '../../storage';
import { initialDocState, type ProjectDocs } from '../collab/documents';
import { prepareFiles, type IncomingFile, type ProjectLimits } from '../files/service';
import { writeZip, type ZipItem } from './zip';

/** Lector: ver, exportar y compilar. Editor: además, escribir. Dueño: además, administrar. */
export type ProjectAction = 'read' | 'write' | 'manage';

const REQUIRED: Record<ProjectAction, ProjectRole> = { read: 'viewer', write: 'editor', manage: 'owner' };

export const roleAllows = (role: ProjectRole, action: ProjectAction) => ROLE_RANK[role] >= ROLE_RANK[REQUIRED[action]];
export { higherRole };

export interface ProjectAccess {
  project: Project;
  role: ProjectRole;
}

/**
 * Puerta de toda acción sobre un proyecto. Quien no es miembro recibe 404, igual que si el proyecto no
 * existiera: no se revela su existencia. Un rol que no alcanza recibe 403.
 */
export async function assertProjectAccess(db: Db, userId: string, projectId: string, action: ProjectAction): Promise<ProjectAccess> {
  const [row] = isUuid(projectId)
    ? await db
        .select({ project: projects, role: projectMembers.role })
        .from(projects)
        .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
        .where(eq(projects.id, projectId))
    : [];
  if (!row) throw new ApiError(404, 'not_found', 'El proyecto no existe');
  if (!roleAllows(row.role, action)) throw new ApiError(403, 'forbidden', 'Tu rol en el proyecto no permite esta acción');
  return row;
}

export function toSummary(project: Project, role: ProjectRole): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    mainFile: project.mainFile,
    engine: project.engine,
    role,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

const MAX_NAME_LENGTH = 120;

export function checkName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || /\p{Cc}/u.test(name)) {
    throw new ApiError(400, 'invalid_name', `El nombre tiene que tener entre 1 y ${MAX_NAME_LENGTH} caracteres`);
  }
  return name;
}

const TEMPLATE = `\\documentclass{article}
\\usepackage[utf8]{inputenc}

\\title{Proyecto nuevo}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introducción}
Escribe aquí.

\\end{document}
`;

export interface ProjectsService {
  list(userId: string): Promise<ProjectSummary[]>;
  /** Proyecto nuevo con un `main.tex` de plantilla. */
  create(userId: string, name: unknown): Promise<ProjectSummary>;
  /** Proyecto nuevo con los archivos de un zip ya leído. */
  createFromFiles(userId: string, name: unknown, incoming: IncomingFile[]): Promise<ProjectSummary>;
  update(access: ProjectAccess, patch: UpdateProjectRequest): Promise<ProjectSummary>;
  remove(projectId: string): Promise<void>;
  exportZip(projectId: string): Promise<Readable>;
}

export interface ProjectsDeps {
  db: Db;
  storage: Storage;
  docs: ProjectDocs;
  limits: ProjectLimits;
}

export function createProjectsService({ db, storage, docs, limits }: ProjectsDeps): ProjectsService {
  const service: ProjectsService = {
    async list(userId) {
      const rows = await db
        .select({ project: projects, role: projectMembers.role })
        .from(projects)
        .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
        .where(eq(projectMembers.userId, userId))
        .orderBy(desc(projects.updatedAt));
      return rows.map((r) => toSummary(r.project, r.role));
    },

    create(userId, name) {
      return service.createFromFiles(userId, name, [{ path: DEFAULT_MAIN_FILE, data: Buffer.from(TEMPLATE) }]);
    },

    async createFromFiles(userId, rawName, incoming) {
      const name = checkName(rawName);
      const prepared = prepareFiles(incoming, [], limits);
      const projectId = randomUUID();
      const texts = new Map(prepared.flatMap((f) => (f.text === undefined ? [] : [[f.id, f.text] as const])));
      const main = pickMainFile(prepared);
      const engine = (main && detectEngineFromSource(texts.get(main.id) ?? '')) ?? 'pdflatex';

      // Primero los binarios en S3 (un fallo deja objetos huérfanos, nunca filas sin objeto).
      for (const file of prepared) if (file.kind === 'binary') await storage.put(fileKey(projectId, file.id), file.data);
      const project = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(projects)
          .values({ id: projectId, name, mainFile: main?.path ?? DEFAULT_MAIN_FILE, engine })
          .returning();
        await tx.insert(projectMembers).values({ projectId, userId, role: 'owner' });
        if (prepared.length > 0) {
          await tx.insert(files).values(
            prepared.map((f) => ({ id: f.id, projectId, path: f.path, pathKey: f.pathKey, kind: f.kind, size: f.size })),
          );
        }
        await tx.insert(documents).values({ projectId, state: initialDocState(texts) });
        return created;
      });
      if (!project) throw new Error('no se creó el proyecto');
      return toSummary(project, 'owner');
    },

    async update({ project, role }, patch) {
      const changes: Partial<Pick<Project, 'name' | 'mainFile' | 'engine'>> = {};
      if (patch.name !== undefined) {
        if (!roleAllows(role, 'manage')) throw new ApiError(403, 'forbidden', 'Solo el dueño puede renombrar el proyecto');
        changes.name = checkName(patch.name);
      }
      if (patch.engine !== undefined) {
        if (!(ENGINES as readonly unknown[]).includes(patch.engine)) {
          throw new ApiError(400, 'invalid_engine', `Motor inválido; opciones: ${ENGINES.join(', ')}`);
        }
        changes.engine = patch.engine as Engine;
      }
      if (patch.mainFile !== undefined) {
        const mainFile = String(patch.mainFile);
        const [file] = await db
          .select({ kind: files.kind })
          .from(files)
          .where(and(eq(files.projectId, project.id), eq(files.path, mainFile)));
        if (!file || file.kind !== 'text' || !isValidMainFile(mainFile)) {
          throw new ApiError(400, 'invalid_main_file', 'El documento principal tiene que ser un .tex del proyecto, con un nombre sin espacios');
        }
        changes.mainFile = mainFile;
      }
      const [updated] = await db
        .update(projects)
        .set({ ...changes, updatedAt: sql`now()` })
        .where(eq(projects.id, project.id))
        .returning();
      docs.notify(project.id, 'project-changed');
      return toSummary(updated ?? project, role);
    },

    async remove(projectId) {
      // Primero las filas (en cascada: miembros, archivos, documento y enlaces); después los objetos.
      await db.delete(projects).where(eq(projects.id, projectId));
      docs.disconnect(projectId);
      await storage.deletePrefix(projectPrefix(projectId));
    },

    async exportZip(projectId) {
      const rows = await db.select().from(files).where(eq(files.projectId, projectId)).orderBy(files.path);
      const texts = await docs.read(projectId, (map) => new Map(rows.map((r) => [r.id, map.get(r.id)?.toString() ?? ''])));
      const items: ZipItem[] = rows.map((row) => ({
        path: row.path,
        content:
          row.kind === 'text'
            ? Buffer.from(texts.get(row.id) ?? '', 'utf8')
            : async () => {
                const stream = await storage.get(fileKey(projectId, row.id));
                if (!stream) throw new Error(`falta el objeto de ${row.path}`);
                return stream;
              },
      }));
      return writeZip(items);
    },
  };
  return service;
}

/**
 * `main.tex` si existe; si no, un .tex con `\documentclass`: primero los que no son figuras sueltas
 * (clase `standalone`), después los de menos profundidad y, entre esos, el más largo (una tesis suele
 * venir con figuras TikZ compilables por separado al lado del documento).
 */
function pickMainFile(prepared: readonly { id: string; path: string; text?: string }[]) {
  const documents = prepared.filter((f) => f.text !== undefined && isValidMainFile(f.path));
  const main = documents.find((f) => f.path === DEFAULT_MAIN_FILE);
  if (main) return main;
  const depth = (path: string) => path.split('/').length;
  const standalone = (text: string) => (/^[^%\n]*\\documentclass(?:\[[^\]]*\])?\{standalone\}/m.test(text) ? 1 : 0);
  return documents
    .filter((f) => /^[^%\n]*\\documentclass/m.test(f.text ?? ''))
    .sort(
      (a, b) =>
        standalone(a.text ?? '') - standalone(b.text ?? '') ||
        depth(a.path) - depth(b.path) ||
        (b.text?.length ?? 0) - (a.text?.length ?? 0) ||
        a.path.localeCompare(b.path),
    )[0];
}
