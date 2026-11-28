// /api/projects: listar, crear, importar zip, ver, cambiar, borrar y exportar zip.
import type { FastifyInstance } from 'fastify';
import { ENGINES, type CreateProjectRequest, type UpdateProjectRequest } from '@latexweb/shared';
import type { Db } from '../../db';
import { ApiError, contentDisposition } from '../../http';
import { binary, empty, errors, idParams, multipart, skipValidation, wrap, wrapList } from '../../openapi';
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

const tags = ['projects'];
const params = idParams('id');

/** Las rutas exigen sesión: se registran detrás de `requireUser`. */
export async function projectsRoutes(app: FastifyInstance, { db, projects, limits }: ProjectRoutesDeps): Promise<void> {
  app.get(
    '/projects',
    { schema: { tags, summary: 'Mis proyectos, con mi rol, del más reciente al más viejo', response: { 200: wrapList('projects', 'Project'), ...errors } } },
    async (request) => ({ projects: await projects.list(currentUserId(request)) }),
  );

  app.post<{ Body: CreateProjectRequest }>(
    '/projects',
    {
      schema: {
        tags,
        summary: 'Crear un proyecto con un main.tex de plantilla',
        body: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', examples: ['Tesis'] } } },
        response: { 201: wrap('project', 'Project'), ...errors },
      },
    },
    async (request, reply) => {
      const project = await projects.create(currentUserId(request), request.body?.name);
      return reply.code(201).send({ project });
    },
  );

  app.post(
    '/projects/import',
    {
      schema: {
        tags,
        summary: 'Crear un proyecto desde un zip',
        description:
          'Detecta el documento principal y el motor. Se ignoran `__MACOSX/`, los ocultos y `latexmkrc`; si todo está ' +
          'en una carpeta, se quita. Se rechazan rutas inválidas, symlinks y zips que superan los topes.',
        ...multipart(
          { file: { type: 'string', format: 'binary', description: 'El zip' }, name: { type: 'string', description: 'Nombre; por defecto, el del zip' } },
          'Zip y nombre opcional',
        ),
        response: { 201: wrap('project', 'Project'), ...errors },
      },
      validatorCompiler: skipValidation,
    },
    async (request, reply) => {
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
    },
  );

  app.get<WithId>(
    '/projects/:id',
    { schema: { tags, summary: 'Ver un proyecto', params, response: { 200: wrap('project', 'Project'), ...errors } } },
    async (request) => {
      const { project, role } = await assertProjectAccess(db, currentUserId(request), request.params.id, 'read');
      return { project: toSummary(project, role) };
    },
  );

  app.patch<WithId & { Body: UpdateProjectRequest }>(
    '/projects/:id',
    {
      schema: {
        tags,
        summary: 'Cambiar nombre (dueño), documento principal o motor (editor)',
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            mainFile: { type: 'string' },
            // Sin enum: un motor inválido responde invalid_engine, no un error de validación genérico.
            engine: { type: 'string', description: `Uno de: ${ENGINES.join(', ')}` },
          },
        },
        response: { 200: wrap('project', 'Project'), ...errors },
      },
    },
    async (request) => {
      const access = await assertProjectAccess(db, currentUserId(request), request.params.id, 'write');
      return { project: await projects.update(access, request.body ?? {}) };
    },
  );

  app.delete<WithId>(
    '/projects/:id',
    { schema: { tags, summary: 'Borrar el proyecto (dueño)', params, response: { 204: empty, ...errors } } },
    async (request, reply) => {
      const { project } = await assertProjectAccess(db, currentUserId(request), request.params.id, 'manage');
      await projects.remove(project.id);
      return reply.code(204).send();
    },
  );

  app.get<WithId>(
    '/projects/:id/export',
    { schema: { tags, summary: 'Descargar el proyecto como zip', params, produces: ['application/zip'], response: { 200: binary('El zip'), ...errors } } },
    async (request, reply) => {
      const { project } = await assertProjectAccess(db, currentUserId(request), request.params.id, 'read');
      const stream = await projects.exportZip(project.id);
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', contentDisposition('attachment', `${project.name}.zip`))
        .send(stream);
    },
  );
}
