// Miembros y enlaces de un proyecto (solo el dueño) y unirse con un enlace (cualquiera con sesión).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ASSIGNABLE_ROLES, type CreateShareLinkRequest, type UpdateMemberRequest } from '@latexweb/shared';
import type { Db } from '../../db';
import { empty, errors, idParams, wrap, wrapList } from '../../openapi';
import { currentUserId } from '../auth/guard';
import { assertProjectAccess } from '../projects/service';
import type { SharingService } from './service';

export interface SharingRoutesDeps {
  db: Db;
  sharing: SharingService;
}

type WithId = { Params: { id: string } };
type WithMember = { Params: { id: string; userId: string } };

const tags = ['sharing'];
const role = { type: 'string', enum: [...ASSIGNABLE_ROLES] };

/** Las rutas exigen sesión: se registran detrás de `requireUser`. */
export async function sharingRoutes(app: FastifyInstance, { db, sharing }: SharingRoutesDeps): Promise<void> {
  const owned = async (request: FastifyRequest<WithId>) =>
    (await assertProjectAccess(db, currentUserId(request), request.params.id, 'manage')).project.id;

  app.get<WithId>(
    '/projects/:id/members',
    { schema: { tags, summary: 'Miembros del proyecto', params: idParams('id'), response: { 200: wrapList('members', 'Member'), ...errors } } },
    async (request) => ({ members: await sharing.members(await owned(request)) }),
  );

  app.patch<WithMember & { Body: UpdateMemberRequest }>(
    '/projects/:id/members/:userId',
    {
      schema: {
        tags,
        summary: 'Cambiar el rol de un miembro',
        description: 'Sus conexiones en vivo se cierran y vuelven a entrar con el rol nuevo.',
        params: idParams('id', 'userId'),
        body: { type: 'object', properties: { role } },
        response: { 200: wrap('member', 'Member'), ...errors },
      },
    },
    async (request) => ({ member: await sharing.setRole(await owned(request), request.params.userId, request.body?.role) }),
  );

  app.delete<WithMember>(
    '/projects/:id/members/:userId',
    { schema: { tags, summary: 'Quitar a un miembro (y cerrar sus conexiones en vivo)', params: idParams('id', 'userId'), response: { 204: empty, ...errors } } },
    async (request, reply) => {
      await sharing.removeMember(await owned(request), request.params.userId);
      return reply.code(204).send();
    },
  );

  app.post<WithId & { Body: CreateShareLinkRequest }>(
    '/projects/:id/share-links',
    {
      schema: {
        tags,
        summary: 'Crear un enlace para compartir',
        description: 'El token se devuelve solo aquí; se guarda su hash.',
        params: idParams('id'),
        body: { type: 'object', properties: { role, expiresInDays: { type: 'integer', minimum: 1, maximum: 365 } } },
        response: { 201: wrap('link', 'ShareLink'), ...errors },
      },
    },
    async (request, reply) => {
      const projectId = await owned(request);
      const link = await sharing.createLink(projectId, currentUserId(request), request.body?.role, request.body?.expiresInDays);
      return reply.code(201).send({ link });
    },
  );

  app.get<WithId>(
    '/projects/:id/share-links',
    { schema: { tags, summary: 'Enlaces vigentes (sin el token)', params: idParams('id'), response: { 200: wrapList('links', 'ShareLink'), ...errors } } },
    async (request) => ({ links: await sharing.links(await owned(request)) }),
  );

  app.delete<{ Params: { id: string; linkId: string } }>(
    '/projects/:id/share-links/:linkId',
    { schema: { tags, summary: 'Revocar un enlace', params: idParams('id', 'linkId'), response: { 204: empty, ...errors } } },
    async (request, reply) => {
      await sharing.revokeLink(await owned(request), request.params.linkId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { token: string } }>(
    '/share/:token',
    {
      schema: {
        tags,
        summary: 'Ver qué proyecto y rol da un enlace, sin unirse',
        description: 'Del dueño se muestra solo el nombre. `currentRole`: mi rol si ya soy miembro.',
        params: idParams('token'),
        response: {
          200: {
            type: 'object',
            properties: {
              preview: {
                type: 'object',
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                  projectName: { type: 'string' },
                  ownerName: { type: ['string', 'null'] },
                  role,
                  currentRole: { type: ['string', 'null'] },
                },
                required: ['projectId', 'projectName', 'ownerName', 'role', 'currentRole'],
              },
            },
            required: ['preview'],
          },
          ...errors,
        },
      },
    },
    async (request) => ({ preview: await sharing.preview(currentUserId(request), request.params.token) }),
  );

  app.post<{ Params: { token: string } }>(
    '/share/:token/join',
    {
      schema: {
        tags,
        summary: 'Unirse a un proyecto con un enlace',
        description: 'Si ya era miembro, se queda con el rol más alto.',
        params: idParams('token'),
        response: {
          200: {
            type: 'object',
            properties: { projectId: { type: 'string', format: 'uuid' }, role: { type: 'string' } },
            required: ['projectId', 'role'],
          },
          ...errors,
        },
      },
    },
    async (request) => sharing.join(currentUserId(request), request.params.token),
  );
}
