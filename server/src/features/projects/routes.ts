// /api/projects: listar, crear, importar zip, ver, cambiar, borrar y exportar zip.
import type { FastifyInstance } from 'fastify';
import type { CreateProjectRequest, UpdateProjectRequest } from '@latexweb/shared';
import type { Db } from '../../db';
import { ApiError, contentDisposition } from '../../http';
import { currentUserId } from '../auth/guard';
import type { ProjectLimits } from '../files/service';
import { assertProjectAccess, toSummary, type ProjectsService } from './service';
import { readZip } from './zip';

export interface ProjectRoutesDeps {
  db: Db;
  projects: ProjectsService;
  limits: ProjectLimits;
}

type WithId = { Params: { id: string } };

/** Las rutas exigen sesión: se registran detrás de `requireUser`. */
export async function projectsRoutes(app: FastifyInstance, { db, projects, limits }: ProjectRoutesDeps): Promise<void> {
  app.get('/projects', async (request) => ({ projects: await projects.list(currentUserId(request)) }));

  app.post<{ Body: CreateProjectRequest }>('/projects', async (request, reply) => {
    const project = await projects.create(currentUserId(request), request.body?.name);
    return reply.code(201).send({ project });
  });

  // Multipart con el zip (`file`) y, opcional, el nombre (`name`); sin nombre, el del zip.
  app.post('/projects/import', async (request, reply) => {
    if (!request.isMultipart()) throw new ApiError(400, 'invalid_request', 'Se espera multipart/form-data con un zip');
    let name: unknown;
    let zip: { filename: string; data: Buffer } | undefined;
    for await (const part of request.parts({ limits: { fileSize: limits.maxBytes, files: 1 } })) {
      if (part.type === 'file') zip = { filename: part.filename, data: await part.toBuffer() };
      else if (part.fieldname === 'name') name = part.value;
    }
    if (!zip) throw new ApiError(400, 'invalid_request', 'Falta el zip');
    const incoming = await readZip(zip.data, limits);
    const fallbackName = zip.filename.split('/').pop()?.replace(/\.zip$/i, '') || 'Proyecto importado';
    const project = await projects.createFromFiles(currentUserId(request), name ?? fallbackName, incoming);
    return reply.code(201).send({ project });
  });

  app.get<WithId>('/projects/:id', async (request) => {
    const { project, role } = await assertProjectAccess(db, currentUserId(request), request.params.id, 'read');
    return { project: toSummary(project, role) };
  });

  app.patch<WithId & { Body: UpdateProjectRequest }>('/projects/:id', async (request) => {
    const access = await assertProjectAccess(db, currentUserId(request), request.params.id, 'write');
    return { project: await projects.update(access, request.body ?? {}) };
  });

  app.delete<WithId>('/projects/:id', async (request, reply) => {
    const { project } = await assertProjectAccess(db, currentUserId(request), request.params.id, 'manage');
    await projects.remove(project.id);
    return reply.code(204).send();
  });

  app.get<WithId>('/projects/:id/export', async (request, reply) => {
    const { project } = await assertProjectAccess(db, currentUserId(request), request.params.id, 'read');
    const stream = await projects.exportZip(project.id);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition('attachment', `${project.name}.zip`))
      .send(stream);
  });
}
