import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db';
import { files, mutationAudit, projectMembers, projects, shareLinks } from '../../schema';
import { ApiError } from '../../http';
import type { ProjectDocs } from '../collab/documents';
import { assertProjectAccess } from '../projects/service';

type Event = typeof mutationAudit.$inferInsert;
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function createMutationAudit(db: Db) {
  return {
    async begin(event: Pick<Event, 'actorId' | 'projectId' | 'resourceId' | 'action' | 'source' | 'before'>): Promise<string> {
      const [row] = await db.insert(mutationAudit).values({ ...event, outcome: 'pending' }).returning({ id: mutationAudit.id });
      if (!row) throw new Error('No se pudo registrar la intención de mutación');
      return row.id;
    },
    async finish(id: string, event: Pick<Event, 'after' | 'outcome'> & Partial<Pick<Event, 'projectId' | 'resourceId' | 'statusCode'>>): Promise<void> {
      await db.update(mutationAudit).set({ ...event, completedAt: new Date() }).where(eq(mutationAudit.id, id));
    },
    async list(actorId: string, projectId: string, limit = 50) {
      await assertProjectAccess(db, actorId, projectId, 'manage');
      return db.select().from(mutationAudit).where(eq(mutationAudit.projectId, projectId))
        .orderBy(desc(mutationAudit.createdAt), desc(mutationAudit.id)).limit(Math.min(100, Math.max(1, limit)));
    },
  };
}
export type MutationAudit = ReturnType<typeof createMutationAudit>;
export interface AuditTarget { fileId?: string; userId?: string; linkId?: string; fileTree?: boolean }

/** Selección explícita: nunca copiar cuerpos, credenciales, emails ni contenido de archivos. */
export async function metadataSnapshot(db: Db, docs: ProjectDocs, actorId: string, projectId: string | null,
  target: AuditTarget): Promise<Record<string, unknown> | null> {
  if (!projectId) return null;
  try { await assertProjectAccess(db, actorId, projectId, 'read'); }
  catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.statusCode)) return null;
    throw error;
  }
  const [project] = await db.select({ id: projects.id, name: projects.name, mainFile: projects.mainFile, engine: projects.engine })
    .from(projects).where(eq(projects.id, projectId));
  const snapshot: Record<string, unknown> = { project: project ?? null };
  if (target.fileTree) {
    const rows = await db.select({ id: files.id, path: files.path, kind: files.kind, size: files.size })
      .from(files).where(eq(files.projectId, projectId)).orderBy(files.id).limit(101);
    snapshot.files = rows.slice(0, 100);
    snapshot.filesTruncated = rows.length > 100;
  }
  if (target.fileId) {
    const [file] = await db.select({ id: files.id, path: files.path, kind: files.kind, size: files.size })
      .from(files).where(and(eq(files.projectId, projectId), eq(files.id, target.fileId)));
    snapshot.file = file ?? null;
    if (file?.kind === 'text') snapshot.textSha256 = await docs.read(projectId, (map) => sha256(map.get(file.id)?.toString() ?? ''));
  }
  if (target.userId) {
    const [member] = await db.select({ userId: projectMembers.userId, role: projectMembers.role }).from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, target.userId)));
    snapshot.member = member ?? null;
  }
  if (target.linkId) {
    const [link] = await db.select({ id: shareLinks.id, role: shareLinks.role, expiresAt: shareLinks.expiresAt,
      revokedAt: shareLinks.revokedAt, acceptedAt: shareLinks.acceptedAt }).from(shareLinks)
      .where(and(eq(shareLinks.projectId, projectId), eq(shareLinks.id, target.linkId)));
    snapshot.link = link ?? null;
  }
  return snapshot;
}
