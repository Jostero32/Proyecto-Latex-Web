// Rutas /auth. Ver docs/specs/auth.md.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { sendError } from '../../lib/http-error';
import { createRequireUser, SESSION_COOKIE } from './guard';
import { AuthError, type AuthService, type SessionResult } from './service';

export interface AuthDeps {
  service: AuthService;
  cookieSecure: boolean;
  /** Almacén del rate limit; sin esto, en memoria (tests). */
  redis?: Redis | undefined;
}

const RATE_LIMIT = { max: 10, timeWindow: 15 * 60 * 1000 };

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

  await app.register(import('@fastify/rate-limit'), {
    global: false,
    ...(deps.redis ? { redis: deps.redis, nameSpace: 'latexweb-ratelimit-' } : {}),
    // Si Redis no responde, no se bloquea el login por eso.
    skipOnError: true,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `Demasiados intentos; reintenta en ${Math.ceil(context.ttl / 1000)} s`,
    }),
  });
  // Dos límites independientes: por IP y por email (el email se lee del cuerpo, en preHandler).
  const limitByIp = app.rateLimit({ ...RATE_LIMIT, keyGenerator: (request) => `ip:${request.ip}` });
  const limitByEmail = app.rateLimit({
    ...RATE_LIMIT,
    keyGenerator: (request) => `email:${emailOf(request) ?? request.ip}`,
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

  app.post('/auth/register', { preHandler: [limitByIp, limitByEmail] }, async (request, reply) => {
    const body = objectBody(request);
    await dropCurrentSession(request);
    const session = await service.register({ email: body.email, password: body.password, name: body.name });
    return setSession(reply, session).code(201).send({ user: session.user });
  });

  app.post('/auth/login', { preHandler: [limitByIp, limitByEmail] }, async (request, reply) => {
    const body = objectBody(request);
    await dropCurrentSession(request);
    const session = await service.login({ email: body.email, password: body.password });
    return setSession(reply, session).send({ user: session.user });
  });

  app.post('/auth/logout', async (request, reply) => {
    await dropCurrentSession(request);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.get('/auth/me', { preHandler: requireUser }, async (request) => ({ user: request.user }));
}

function objectBody(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function emailOf(request: FastifyRequest): string | null {
  const email = objectBody(request).email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : null;
}
