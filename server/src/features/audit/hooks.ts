import { isUuid } from '@latexweb/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../../db';
import { ApiError } from '../../http';
import { shareLinks } from '../../schema';
import type { ProjectDocs } from '../collab/documents';
import { metadataSnapshot, sha256, type AuditTarget, type MutationAudit } from './service';

/** Intención duradera antes del handler; sin éxito inventado si cae el proceso a mitad. */
export function registerMutationAudit(app: FastifyInstance, db: Db, docs: ProjectDocs, audit: MutationAudit): void {
  const pending = new WeakMap<FastifyRequest, { id: string; projectId: string | null;
    target: AuditTarget; finished: boolean }>();
  app.addHook('preHandler', async (request) => {
    if (!request.user || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const route = request.routeOptions.url;
    if (!route || (!route.includes('/projects') && !route.includes('/share/:token/join'))) return;
    const params = request.params as Record<string, string | undefined>;
    let projectId = params.id && isUuid(params.id) ? params.id : null;
    const target: AuditTarget = Object.fromEntries(['fileId', 'userId', 'linkId'].flatMap((key) => {
      const value = params[key];
      return value && isUuid(value) ? [[key, value]] : [];
    }));
    target.fileTree = route.endsWith('/files') || (request.method === 'POST' && (route.endsWith('/projects') || route.endsWith('/projects/import')));
    if (params.token) {
      const [link] = await db.select({ id: shareLinks.id, projectId: shareLinks.projectId })
        .from(shareLinks).where(eq(shareLinks.tokenHash, sha256(params.token)));
      if (link) { projectId = link.projectId; target.linkId = link.id; }
    }
    try {
      const before = await metadataSnapshot(db, docs, request.user.id, projectId, target);
      const id = await audit.begin({ actorId: request.user.id, projectId, resourceId: target.fileId ?? target.userId ?? target.linkId ?? projectId,
        action: `${request.method} ${route}`, source: 'http', before });
      pending.set(request, { id, projectId, target, finished: false });
    } catch {
      throw new ApiError(503, 'audit_unavailable', 'No se pudo registrar la operación; no se ha ejecutado');
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const event = pending.get(request);
    if (!event || event.finished || !request.user) return payload;
    event.finished = true; // Evita recursión si falla la escritura y se serializa el error.
    try {
      // Solo IDs de la respuesta propia serializada; nunca se registra el JSON ni su token.
      if (reply.statusCode < 400 && typeof payload === 'string') {
        let response: { project?: { id?: string }; link?: { id?: string } } = {};
        try { response = JSON.parse(payload) as typeof response; } catch { /* Respuesta sin JSON. */ }
        if (response.project?.id && isUuid(response.project.id)) event.projectId = response.project.id;
        if (response.link?.id && isUuid(response.link.id)) event.target.linkId = response.link.id;
      }
      const after = await metadataSnapshot(db, docs, request.user.id, event.projectId, event.target);
      await audit.finish(event.id, { projectId: event.projectId,
        resourceId: event.target.fileId ?? event.target.userId ?? event.target.linkId ?? event.projectId,
        after, statusCode: reply.statusCode,
        outcome: reply.statusCode < 400 ? 'applied' : [401, 403, 404].includes(reply.statusCode) ? 'denied' : 'failed' });
    } catch {
      throw new ApiError(503, 'audit_unavailable', 'Registro pendiente: comprueba el estado de la operación antes de repetirla');
    }
    return payload;
  });
}
