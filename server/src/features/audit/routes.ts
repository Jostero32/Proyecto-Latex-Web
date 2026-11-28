import type { ListMutationAuditResponse } from '@latexweb/shared';
import type { FastifyInstance } from 'fastify';
import { errors, idParams } from '../../openapi';
import { currentUserId } from '../auth/guard';
import type { MutationAudit } from './service';

export async function auditRoutes(app: FastifyInstance, audit: MutationAudit): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>('/projects/:id/audit-events', {
    schema: { tags: ['projects'], summary: 'Últimas mutaciones; solo el dueño', params: idParams('id'),
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      response: { 200: { type: 'object', properties: { events: { type: 'array', items: {
        type: 'object', properties: {
          id: { type: 'string' }, actorId: { type: 'string' }, projectId: { type: ['string', 'null'] },
          resourceId: { type: ['string', 'null'] }, action: { type: 'string' }, source: { type: 'string' }, outcome: { type: 'string' },
          statusCode: { type: ['integer', 'null'] }, createdAt: { type: 'string' }, completedAt: { type: ['string', 'null'] },
          before: { type: ['object', 'null'], additionalProperties: true }, after: { type: ['object', 'null'], additionalProperties: true },
        }, required: ['id', 'actorId', 'projectId', 'resourceId', 'action', 'source', 'outcome', 'statusCode', 'before', 'after', 'createdAt', 'completedAt'],
      } } }, required: ['events'] }, ...errors },
    },
  }, async (request): Promise<ListMutationAuditResponse> => ({ events: (await audit.list(currentUserId(request), request.params.id, request.query.limit)).map((event) => ({ ...event, createdAt: event.createdAt.toISOString(), completedAt: event.completedAt?.toISOString() ?? null })) }));
}
