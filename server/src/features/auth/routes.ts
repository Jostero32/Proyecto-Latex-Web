// Rutas /auth. Ver docs/specs/auth.md.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { Redis } from 'ioredis';
import { sendError } from '../../http';
import { errors, wrap } from '../../openapi';
import { createRequireUser, SESSION_COOKIE } from './guard';
import { AuthError, type AuthService, type SessionResult } from './service';

export interface AuthDeps {
  service: AuthService;
  cookieSecure: boolean;
  /** Almacén del rate limit; sin esto, en memoria (tests). */
  redis?: Redis | undefined;
}

const RATE_LIMIT = { max: 10, timeWindow: 15 * 60 * 1000 };

const credentials = (withName: boolean) => ({
  type: 'object',
  properties: {
    email: { type: 'string', examples: ['ana@ejemplo.com'] },
    password: { type: 'string', description: 'Al registrarse, al menos 10 caracteres' },
    ...(withName ? { name: { type: 'string' } } : {}),
  },
});
const noSession = { security: [] as never[] };
const AUTH_BODY_LIMIT = 4096;

const ERROR_STATUS: Record<AuthError['code'], number> = {
  invalid_email: 400,
  weak_password: 400,
  invalid_name: 400,
  email_taken: 409,
  invalid_credentials: 401,
};

export async function authRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { service, cookieSecure } = deps;
  const requireUser = createRequireUser(service);

  await app.register(rateLimit, {
    global: false,
    ...(deps.redis ? { redis: deps.redis, nameSpace: 'latexweb-ratelimit-' } : {}),
    // Si Redis no responde, no se bloquea el login por eso (ver docs/backlog.md).
    skipOnError: true,
  });
  // Dos límites independientes: por IP (IPv6 agrupada por /64, como hace la librería por defecto) y
  // por email. Con app.rateLimit() solo correría el primero: los handlers comparten la marca
  // "ya limitado" de la librería. createRateLimit evalúa cada uno sin esa marca.
  const byIp = app.createRateLimit({ ...RATE_LIMIT, keyGenerator: (request) => `ip:${normalizeIP(request.ip, 64)}` });
  const byEmail = app.createRateLimit({
    ...RATE_LIMIT,
    keyGenerator: (request) => `email:${emailOf(request) ?? normalizeIP(request.ip, 64)}`,
  });
  const limitAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    for (const limiter of [byIp, byEmail]) {
      const result = await limiter(request);
      // isAllowed=true es "en la lista de excluidos" (no aplica el límite).
      if (!result.isAllowed && result.isExceeded) {
        reply.header('Retry-After', String(result.ttlInSeconds));
        return sendError(reply, 429, 'rate_limited', `Demasiados intentos; reintenta en ${result.ttlInSeconds} s`);
      }
    }
  };
  // Respuestas con datos del usuario o Set-Cookie: nunca en una caché compartida.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof AuthError) return sendError(reply, ERROR_STATUS[error.code], error.code, error.message);
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status === 429) return sendError(reply, 429, 'rate_limited', error.message);
    if (status >= 500) {
      request.log.error({ err: error }, 'error interno en /auth');
      return sendError(reply, 500, 'internal_error', 'Error interno del servidor');
    }
    return sendError(reply, status, 'invalid_request', 'Petición inválida');
  });

  const setSession = (reply: FastifyReply, session: SessionResult) =>
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure,
      path: '/',
      expires: session.expiresAt,
    });

  /** Al iniciar sesión se descarta la anterior (contra la fijación de sesión). */
  const dropCurrentSession = async (request: FastifyRequest) => {
    const current = request.cookies[SESSION_COOKIE];
    if (current) await service.logout(current);
  };

  // bodyLimit: un email y una contraseña de hasta 256 caracteres entran de sobra en 4 KB.
  app.post('/auth/register', {
    preHandler: limitAuth,
    bodyLimit: AUTH_BODY_LIMIT,
    schema: { tags: ['auth'], summary: 'Crear una cuenta e iniciar sesión', ...noSession, body: credentials(true), response: { 201: wrap('user', 'User'), ...errors } },
  }, async (request, reply) => {
    const body = objectBody(request);
    await dropCurrentSession(request);
    const session = await service.register({ email: body.email, password: body.password, name: body.name });
    return setSession(reply, session).code(201).send({ user: session.user });
  });

  app.post('/auth/login', {
    preHandler: limitAuth,
    bodyLimit: AUTH_BODY_LIMIT,
    schema: { tags: ['auth'], summary: 'Iniciar sesión (deja la cookie sid)', ...noSession, body: credentials(false), response: { 200: wrap('user', 'User'), ...errors } },
  }, async (request, reply) => {
    const body = objectBody(request);
    await dropCurrentSession(request);
    const session = await service.login({ email: body.email, password: body.password });
    return setSession(reply, session).send({ user: session.user });
  });

  app.post('/auth/logout', { schema: { tags: ['auth'], summary: 'Cerrar la sesión', response: { 204: { type: 'null', description: 'Sin contenido' } } } }, async (request, reply) => {
    await dropCurrentSession(request);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.get('/auth/me', { preHandler: requireUser, schema: { tags: ['auth'], summary: 'Usuario de la sesión', response: { 200: wrap('user', 'User'), ...errors } } }, async (request) => ({ user: request.user }));
}

function objectBody(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function emailOf(request: FastifyRequest): string | null {
  const email = objectBody(request).email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : null;
}
