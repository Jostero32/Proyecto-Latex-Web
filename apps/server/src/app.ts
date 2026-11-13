// Construcción del servidor (API REST + colaboración), separada del arranque para poder testearla.
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { attachCollab } from './modules/collab/collab.websocket';

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get('/health', async () => ({ ok: true }));
  attachCollab(app);

  return app;
}
