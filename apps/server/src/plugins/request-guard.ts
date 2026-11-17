// Rechaza peticiones HTTP con un Host no permitido (DNS rebinding) y peticiones que modifican estado
// con un Origin no permitido (peticiones cruzadas desde el navegador). El upgrade de WebSocket no
// pasa por los hooks de Fastify: lo valida la funcionalidad collab con las mismas funciones.
import type { FastifyInstance } from 'fastify';
import { sendError } from '../lib/http-error';
import { isAllowedHost, isAllowedOrigin, type RequestGuardOptions } from '../lib/request-guard';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function registerRequestGuard(app: FastifyInstance, options: RequestGuardOptions): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host, options)) {
      return sendError(reply, 403, 'forbidden_host', 'Host no permitido');
    }
    if (!SAFE_METHODS.has(request.method) && !isAllowedOrigin(request.headers.origin, options)) {
      return sendError(reply, 403, 'forbidden_origin', 'Origen no permitido');
    }
  });
}
