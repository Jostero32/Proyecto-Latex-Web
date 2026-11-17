// Lo transversal de HTTP: la forma de los errores y las guardas de Host y Origin.
//
// - Host: contra DNS rebinding. Una página de otro dominio que resuelve a 127.0.0.1 llega con
//   `Host: atacante.com`; solo se aceptan los nombres configurados.
// - Origin: contra peticiones cruzadas desde el navegador (un POST multipart y un WebSocket no
//   pasan por CORS). Sin Origin (curl, scripts, el healthcheck) se acepta: no es un navegador.
//   El upgrade de WebSocket no pasa por los hooks de Fastify: collab usa las mismas funciones.
import type { FastifyInstance, FastifyReply } from 'fastify';

/** Respuesta de error con la forma { error, message } que usa toda la API. */
export function sendError<Code extends string>(
  reply: FastifyReply,
  statusCode: number,
  error: Code,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({ error, message });
}

export interface RequestGuardOptions {
  /** Orígenes exactos, p. ej. `http://localhost:5173`. */
  allowedOrigins: readonly string[];
  /** Nombres de host sin puerto, p. ej. `127.0.0.1`, `localhost`, `[::1]`. */
  allowedHosts: readonly string[];
}

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ['http://127.0.0.1:5173', 'http://localhost:5173'];
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rechaza un Host no permitido y, en métodos que modifican estado, un Origin no permitido. */
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

/** Nombre de host de la cabecera Host, sin puerto y en minúsculas; null si es inválida. */
export function hostName(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const rest = value.slice(end + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return null;
    return value.slice(0, end + 1);
  }
  const match = /^([a-z0-9.-]+)(?::\d{1,5})?$/.exec(value);
  return match?.[1] ?? null;
}

export function isAllowedHost(hostHeader: string | undefined, options: RequestGuardOptions): boolean {
  const name = hostName(hostHeader);
  return name !== null && options.allowedHosts.map((h) => h.toLowerCase()).includes(name);
}

/** Sin Origin → permitido (no es un navegador). `null` (sandbox, file://) → rechazado. */
export function isAllowedOrigin(origin: string | undefined, options: RequestGuardOptions): boolean {
  if (origin === undefined) return true;
  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase();
  return options.allowedOrigins.some((allowed) => allowed.trim().replace(/\/+$/, '').toLowerCase() === normalized);
}
