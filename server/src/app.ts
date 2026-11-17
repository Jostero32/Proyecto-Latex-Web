// Construcción del servidor (API REST + colaboración), separada del arranque para poder testearla.
// La API vive bajo /api; la colaboración, en el WebSocket /collab.
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { authRoutes, type AuthDeps } from './features/auth/routes';
import { registerAuthHooks } from './features/auth/guard';
import { attachCollab } from './features/collab/websocket';
import { compilationsRoutes, type CompilationsDeps } from './features/compilations/routes';
import { DEFAULT_ALLOWED_HOSTS, DEFAULT_ALLOWED_ORIGINS, registerRequestGuard, type RequestGuardOptions } from './http';

export const API_PREFIX = '/api';

export interface AppDeps {
  /** Sin esto no se registran las rutas de auth (p. ej. en los tests de collab). */
  auth?: AuthDeps;
  /** Sin esto no se registran las rutas de compilación. */
  compilations?: CompilationsDeps;
  /** Host y Origin permitidos; por defecto, localhost y el frontend de desarrollo. */
  security?: RequestGuardOptions;
}

/** Campos de texto del multipart además de los archivos (p. ej. mainFile y engine). */
const MAX_MULTIPART_FIELDS = 10;
/** Largo máximo de un campo de texto: rutas de hasta 255 caracteres con margen. */
const MAX_MULTIPART_FIELD_BYTES = 1024;

export async function buildApp(deps: AppDeps = {}, options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify(options);
  const security = deps.security ?? { allowedOrigins: DEFAULT_ALLOWED_ORIGINS, allowedHosts: DEFAULT_ALLOWED_HOSTS };

  registerRequestGuard(app, security);
  // Sin firma: la cookie de sesión es un token aleatorio de 32 bytes que solo vale si existe en la base.
  await app.register(cookie);
  attachCollab(app, security);

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));

      if (deps.auth) {
        const auth = deps.auth;
        registerAuthHooks(api);
        // Contexto encapsulado: el manejador de errores y el rate limit de auth no afectan a otras rutas.
        await api.register(async (scope) => authRoutes(scope, auth));
      }

      if (deps.compilations) {
        const compilations = deps.compilations;
        const limits = compilations.config.upload;
        await api.register(multipart, {
          // Conserva la ruta relativa del filename ("figuras/a.png"); las rutas se validan después
          // con normalizeProjectPath (llegan también rutas como "../x" o "/etc/passwd").
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
        await api.register(async (scope) => compilationsRoutes(scope, compilations));
      }
    },
    { prefix: API_PREFIX },
  );

  return app;
}
