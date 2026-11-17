// Compilar un proyecto y consultar la compilación: estado, diagnósticos y artefactos (PDF, log y
// SyncTeX). Solo para miembros del proyecto.
import { ARTIFACT_KINDS, type ArtifactKind } from '@latexweb/shared';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db';
import { contentDisposition } from '../../http';
import { binary, errors, idParams, wrap } from '../../openapi';
import { currentUserId } from '../auth/guard';
import { assertProjectAccess } from '../projects/service';
import type { CompileService } from './service';

export interface CompileRoutesDeps {
  db: Db;
  compile: CompileService;
}

const ARTIFACT_HEADERS: Record<ArtifactKind, { type: string; disposition: 'inline' | 'attachment'; filename: string }> = {
  pdf: { type: 'application/pdf', disposition: 'inline', filename: 'output.pdf' },
  log: { type: 'text/plain; charset=utf-8', disposition: 'inline', filename: 'output.log' },
  synctex: { type: 'application/gzip', disposition: 'attachment', filename: 'output.synctex.gz' },
};

const tags = ['compile'];

/** Las rutas exigen sesión: se registran detrás de `requireUser`. */
export async function compileRoutes(app: FastifyInstance, { db, compile }: CompileRoutesDeps): Promise<void> {
  // Lector incluido: compilar no cambia el proyecto.
  app.post<{ Params: { id: string } }>(
    '/projects/:id/compile',
    {
      schema: {
        tags,
        summary: 'Compilar el proyecto',
        description:
          'Compila el estado actual (lo último editado en vivo) con el documento principal y el motor del proyecto. ' +
          'Responde enseguida (202); el estado se consulta en GET /compilations/{id}. Sin red y sin shell-escape.',
        params: idParams('id'),
        response: { 202: wrap('compilation', 'Compilation'), ...errors },
      },
    },
    async (request, reply) => {
      const userId = currentUserId(request);
      const { project } = await assertProjectAccess(db, userId, request.params.id, 'read');
      const compilation = await compile.start(project, userId);
      return reply.code(202).header('Location', `/api/compilations/${compilation.id}`).send({ compilation });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/compilations/:id',
    {
      schema: {
        tags,
        summary: 'Estado, diagnósticos y enlaces a los artefactos',
        params: idParams('id'),
        response: { 200: wrap('compilation', 'Compilation'), ...errors },
      },
    },
    async (request) => ({ compilation: await compile.get(currentUserId(request), request.params.id) }),
  );

  app.get<{ Params: { id: string; kind: ArtifactKind } }>(
    '/compilations/:id/:kind',
    {
      schema: {
        tags,
        summary: 'Descargar el PDF, el log o el SyncTeX',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, kind: { type: 'string', enum: ARTIFACT_KINDS } },
          required: ['id', 'kind'],
        },
        response: { 200: binary('PDF, log (texto) o output.synctex.gz'), ...errors },
      },
    },
    async (request, reply) => {
      const { kind } = request.params;
      const stream = await compile.artifact(currentUserId(request), request.params.id, kind);
      const { type, disposition, filename } = ARTIFACT_HEADERS[kind];
      return reply
        .header('Content-Type', type)
        .header('Content-Disposition', contentDisposition(disposition, filename))
        .header('X-Content-Type-Options', 'nosniff')
        // El PDF viene del documento del usuario: si se abre directo en el navegador, sin scripts.
        .header('Content-Security-Policy', 'sandbox')
        .send(stream);
    },
  );
}
