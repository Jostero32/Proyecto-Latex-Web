// Construcción del servidor (API REST + colaboración), separada del arranque para poder testearla.
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { authRoutes, registerAuthHooks, type AuthDeps } from './features/auth';
import { attachCollab } from './features/collab';
import { compilationsRoutes, type CompilationsDeps } from './features/compilations';
import { DEFAULT_ALLOWED_HOSTS, DEFAULT_ALLOWED_ORIGINS, type RequestGuardOptions } from './lib/request-guard';
import { registerCookies } from './plugins/cookies';
import { registerMultipart } from './plugins/multipart';
import { registerRequestGuard } from './plugins/request-guard';

export interface AppDeps {
  /** Sin esto no se registran las rutas de auth (p. ej. en los tests de collab). */
  auth?: AuthDeps;
  /** Sin esto no se registran las rutas de compilación. */
  compilations?: CompilationsDeps;
  /** Host y Origin permitidos; por defecto, localhost y el frontend de desarrollo. */
  security?: RequestGuardOptions;
}

export async function buildApp(deps: AppDeps = {}, options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify(options);
  const security = deps.security ?? { allowedOrigins: DEFAULT_ALLOWED_ORIGINS, allowedHosts: DEFAULT_ALLOWED_HOSTS };

  registerRequestGuard(app, security);
  await registerCookies(app);
  app.get('/health', async () => ({ ok: true }));
  attachCollab(app, security);

  if (deps.auth) {
    const auth = deps.auth;
    registerAuthHooks(app);
    // Contexto encapsulado: el manejador de errores y el rate limit de auth no afectan a otras rutas.
    await app.register(async (scope) => authRoutes(scope, auth));
  }

  if (deps.compilations) {
    const compilations = deps.compilations;
    await registerMultipart(app, compilations.config.upload);
    await app.register(async (scope) => compilationsRoutes(scope, compilations));
  }

  return app;
}
