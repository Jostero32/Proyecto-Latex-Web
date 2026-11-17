// /api/projects/:id/files: árbol, subir (crear o reemplazar por ruta), leer, escribir texto, renombrar
// o mover, y borrar.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RenameFileRequest } from '@latexweb/shared';
import type { Db } from '../../db';
import { ApiError, contentDisposition } from '../../http';
import { currentUserId } from '../auth/guard';
import { assertProjectAccess, type ProjectAction } from '../projects/service';
import { binaryContentType, type FilesService, type IncomingFile, type ProjectLimits } from './service';

export interface FilesRoutesDeps {
  db: Db;
  files: FilesService;
  limits: ProjectLimits;
}

type WithId = { Params: { id: string } };
type WithFile = { Params: { id: string; fileId: string } };

/** Las rutas exigen sesión: se registran detrás de `requireUser`. */
export async function filesRoutes(app: FastifyInstance, { db, files, limits }: FilesRoutesDeps): Promise<void> {
  const access = (request: FastifyRequest<WithId>, action: ProjectAction) =>
    assertProjectAccess(db, currentUserId(request), request.params.id, action);

  app.get<WithId>('/projects/:id/files', async (request) => {
    const { project } = await access(request, 'read');
    return { files: await files.list(project.id) };
  });

  // Cada parte de archivo es un archivo; su filename es la ruta en el proyecto ("figuras/a.png").
  app.post<WithId>('/projects/:id/files', async (request, reply) => {
    const { project } = await access(request, 'write');
    if (!request.isMultipart()) throw new ApiError(400, 'invalid_request', 'Se espera multipart/form-data');
    const incoming: IncomingFile[] = [];
    let total = 0;
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;
      const data = await part.toBuffer();
      total += data.length;
      if (total > limits.maxBytes) throw new ApiError(413, 'project_too_large', `La subida supera ${limits.maxBytes} bytes`);
      incoming.push({ path: part.filename, data });
    }
    if (incoming.length === 0) throw new ApiError(400, 'invalid_request', 'No llegó ningún archivo');
    return reply.code(201).send({ files: await files.upload(project.id, incoming) });
  });

  app.get<WithFile>('/projects/:id/files/:fileId', async (request, reply) => {
    const { project } = await access(request, 'read');
    const content = await files.read(project.id, request.params.fileId);
    reply.header('X-Content-Type-Options', 'nosniff');
    if ('text' in content) return reply.type('text/plain; charset=utf-8').send(content.text);
    const { type, inline } = binaryContentType(content.file.path);
    return reply
      .header('Content-Type', type)
      .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', content.file.path.split('/').pop() ?? 'archivo'))
      // Si se abre directo en el navegador, que no ejecute nada (p. ej. un SVG o un PDF con JS).
      .header('Content-Security-Policy', 'sandbox')
      .send(content.stream);
  });

  // Cuerpo text/plain con el contenido completo.
  app.put<WithFile & { Body: unknown }>('/projects/:id/files/:fileId', { bodyLimit: limits.fileMaxBytes }, async (request) => {
    const { project } = await access(request, 'write');
    if (typeof request.body !== 'string') throw new ApiError(400, 'invalid_request', 'Se espera el contenido como text/plain');
    return { file: await files.writeText(project.id, request.params.fileId, request.body) };
  });

  app.patch<WithFile & { Body: RenameFileRequest }>('/projects/:id/files/:fileId', async (request) => {
    const { project } = await access(request, 'write');
    return { file: await files.rename(project, request.params.fileId, request.body?.path) };
  });

  app.delete<WithFile>('/projects/:id/files/:fileId', async (request, reply) => {
    const { project } = await access(request, 'write');
    await files.remove(project.id, request.params.fileId);
    return reply.code(204).send();
  });
}
