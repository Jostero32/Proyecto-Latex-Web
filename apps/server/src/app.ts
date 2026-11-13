// Construcción del servidor (API REST + colaboración), separada del arranque para poder testearla.
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { attachCollab } from './features/collab';
import { compilationsRoutes, type CompilationsDeps } from './features/compilations';
import { registerMultipart } from './plugins/multipart';

export interface AppDeps {
  /** Sin esto no se registran las rutas de compilación (p. ej. en los tests de collab). */
  compilations?: CompilationsDeps;
}

export async function buildApp(deps: AppDeps = {}, options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify(options);

  app.get('/health', async () => ({ ok: true }));
  attachCollab(app);

  if (deps.compilations) {
    const compilations = deps.compilations;
    await registerMultipart(app, compilations.config.upload);
    // Contexto encapsulado: el manejador de errores del módulo no afecta a /health ni a otras rutas.
    await app.register(async (scope) => compilationsRoutes(scope, compilations));
  }

  return app;
}
