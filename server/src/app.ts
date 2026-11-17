// Construcción del servidor (API REST + colaboración), separada del arranque para poder testearla.
// La API vive bajo /api; la colaboración, en el WebSocket /collab.
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Db } from './db';
import { createRequireUser, registerAuthHooks } from './features/auth/guard';
import { authRoutes, type AuthDeps } from './features/auth/routes';
import { createCollab, createProjectDocs } from './features/collab/documents';
import { attachCollab } from './features/collab/websocket';
import { compilationsRoutes, type CompilationsDeps } from './features/compilations/routes';
import { filesRoutes } from './features/files/routes';
import { createFilesService, type ProjectLimits } from './features/files/service';
import { projectsRoutes } from './features/projects/routes';
import { createProjectsService } from './features/projects/service';
import { sharingRoutes } from './features/sharing/routes';
import { createSharingService } from './features/sharing/service';
import {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_ALLOWED_ORIGINS,
  registerApiErrorHandler,
  registerRequestGuard,
  type RequestGuardOptions,
} from './http';
import type { Storage } from './storage';

export const API_PREFIX = '/api';

export interface AppDeps {
  /** Sin esto no se registran las rutas de auth (p. ej. en los tests de collab). */
  auth?: AuthDeps;
  /** Proyectos, archivos y compartir (requiere `auth`). */
  projects?: { db: Db; storage: Storage; limits: ProjectLimits };
  /** Sin esto no se registran las rutas de compilación. */
  compilations?: CompilationsDeps;
  /** Host y Origin permitidos; por defecto, localhost y el frontend de desarrollo. */
  security?: RequestGuardOptions;
}

/** Campos de texto del multipart además de los archivos (p. ej. mainFile, engine o name). */
const MAX_MULTIPART_FIELDS = 10;
/** Largo máximo de un campo de texto: rutas de hasta 255 caracteres con margen. */
const MAX_MULTIPART_FIELD_BYTES = 1024;

export async function buildApp(deps: AppDeps = {}, options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify(options);
  const security = deps.security ?? { allowedOrigins: DEFAULT_ALLOWED_ORIGINS, allowedHosts: DEFAULT_ALLOWED_HOSTS };

  registerRequestGuard(app, security);
  // Sin firma: la cookie de sesión es un token aleatorio de 32 bytes que solo vale si existe en la base.
  await app.register(cookie);
  const hocuspocus = createCollab(deps.projects?.db);
  attachCollab(app, hocuspocus, security);

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));

      if (deps.auth) {
        const auth = deps.auth;
        registerAuthHooks(api);
        // Contexto encapsulado: el manejador de errores y el rate limit de auth no afectan a otras rutas.
        await api.register(async (scope) => authRoutes(scope, auth));
      }

      if (deps.projects) {
        if (!deps.auth) throw new Error('las rutas de proyectos necesitan auth');
        const { db, storage, limits } = deps.projects;
        const docs = createProjectDocs(hocuspocus, db);
        const requireUser = createRequireUser(deps.auth.service);
        const projects = createProjectsService({ db, storage, docs, limits });
        const files = createFilesService({ db, storage, docs, limits });
        const sharing = createSharingService(db);
        await api.register(async (scope) => {
          registerApiErrorHandler(scope);
          // Datos privados de cada usuario: nunca en una caché compartida.
          scope.addHook('onSend', async (_request, reply) => {
            if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'private, no-store');
          });
          await scope.register(multipart, {
            // Conserva la ruta del filename ("figuras/a.png"); se valida con normalizeProjectPath.
            preservePath: true,
            limits: {
              fileSize: limits.fileMaxBytes,
              files: limits.maxFiles,
              fields: MAX_MULTIPART_FIELDS,
              fieldSize: MAX_MULTIPART_FIELD_BYTES,
              parts: limits.maxFiles + MAX_MULTIPART_FIELDS,
              headerPairs: 100,
            },
          });
          scope.addHook('preHandler', requireUser);
          await projectsRoutes(scope, { db, projects, limits });
          await filesRoutes(scope, { db, files, limits });
          await sharingRoutes(scope, { db, sharing });
        });
      }

      if (deps.compilations) {
        const compilations = deps.compilations;
        const limits = compilations.config.upload;
        await api.register(async (scope) => {
          await scope.register(multipart, {
            preservePath: true,
            limits: {
              fileSize: limits.maxFileBytes,
              files: limits.maxFiles,
              fields: MAX_MULTIPART_FIELDS,
              fieldSize: MAX_MULTIPART_FIELD_BYTES,
              parts: limits.maxFiles + MAX_MULTIPART_FIELDS,
              headerPairs: 100,
            },
          });
          await compilationsRoutes(scope, compilations);
        });
      }
    },
    { prefix: API_PREFIX },
  );

  return app;
}
