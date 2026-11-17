// Miembros y enlaces de un proyecto (solo el dueño) y unirse con un enlace (cualquiera con sesión).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CreateShareLinkRequest, UpdateMemberRequest } from '@latexweb/shared';
import type { Db } from '../../db';
import { currentUserId } from '../auth/guard';
import { assertProjectAccess } from '../projects/service';
import type { SharingService } from './service';

export interface SharingRoutesDeps {
  db: Db;
  sharing: SharingService;
}

type WithId = { Params: { id: string } };
type WithMember = { Params: { id: string; userId: string } };

/** Las rutas exigen sesión: se registran detrás de `requireUser`. */
export async function sharingRoutes(app: FastifyInstance, { db, sharing }: SharingRoutesDeps): Promise<void> {
  const owned = async (request: FastifyRequest<WithId>) =>
    (await assertProjectAccess(db, currentUserId(request), request.params.id, 'manage')).project.id;

  app.get<WithId>('/projects/:id/members', async (request) => ({ members: await sharing.members(await owned(request)) }));

  app.patch<WithMember & { Body: UpdateMemberRequest }>('/projects/:id/members/:userId', async (request) => ({
    member: await sharing.setRole(await owned(request), request.params.userId, request.body?.role),
  }));

  app.delete<WithMember>('/projects/:id/members/:userId', async (request, reply) => {
    await sharing.removeMember(await owned(request), request.params.userId);
    return reply.code(204).send();
  });

  app.post<WithId & { Body: CreateShareLinkRequest }>('/projects/:id/share-links', async (request, reply) => {
    const projectId = await owned(request);
    const link = await sharing.createLink(projectId, currentUserId(request), request.body?.role, request.body?.expiresInDays);
    return reply.code(201).send({ link });
  });

  app.get<WithId>('/projects/:id/share-links', async (request) => ({ links: await sharing.links(await owned(request)) }));

  app.delete<{ Params: { id: string; linkId: string } }>('/projects/:id/share-links/:linkId', async (request, reply) => {
    await sharing.revokeLink(await owned(request), request.params.linkId);
    return reply.code(204).send();
  });

  app.post<{ Params: { token: string } }>('/share/:token/join', async (request) => sharing.join(currentUserId(request), request.params.token));
}
