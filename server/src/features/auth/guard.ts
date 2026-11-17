// Sesión en cada petición, `requireUser` y la regla CSRF con cookie. Ver docs/specs/auth.md.
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { ApiError, sendError } from '../../http';
import type { AuthService, PublicUser } from './service';

export const SESSION_COOKIE = 'sid';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    /** Usuario de la sesión (lo carga `requireUser`); null si no hay sesión válida. */
    user: PublicUser | null;
  }
}

/**
 * Hooks globales de auth. CSRF: además de SameSite=Lax y del guard de Origin (que rechaza un
 * Origin ajeno), una petición que modifica estado y trae la cookie de sesión tiene que traer Origin.
 * Los navegadores siempre lo envían; sin él no se puede saber de qué sitio viene.
 */
export function registerAuthHooks(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    if (!SAFE_METHODS.has(request.method) && request.cookies[SESSION_COOKIE] !== undefined && request.headers.origin === undefined) {
      return sendError(reply, 403, 'forbidden_origin', 'Falta la cabecera Origin en una petición con sesión');
    }
  });
}

/** Id del usuario de la sesión en una ruta protegida por `requireUser`. */
export function currentUserId(request: FastifyRequest): string {
  if (!request.user) throw new ApiError(401, 'unauthenticated', 'Hay que iniciar sesión');
  return request.user.id;
}

/** preHandler que exige una sesión válida y deja el usuario en `request.user`; si no, 401. */
export function createRequireUser(auth: AuthService): preHandlerAsyncHookHandler {
  return async function requireUser(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await auth.getUserBySessionToken(token) : null;
    if (!user) return sendError(reply, 401, 'unauthenticated', 'Hay que iniciar sesión');
    request.user = user;
  };
}
