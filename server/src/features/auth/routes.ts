// Rutas /auth. Ver docs/specs/auth.md.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import { PRIVACY_NOTICE, type AcceptPrivacyRequest } from '@latexweb/shared';
import type { Redis } from 'ioredis';
import { sendError } from '../../http';
import { errors, wrap } from '../../openapi';
import { createRequireUser, SESSION_COOKIE } from './guard';
import { AuthError, type AuthService, type SessionResult } from './service';
import { googleHash, googleRandom, googleReturnPath, GOOGLE_FLOW_SECONDS, type GoogleAuthDeps } from './google';

export interface AuthDeps {
  service: AuthService;
  cookieSecure: boolean;
  /** Almacén del rate limit; sin esto, en memoria (tests). */
  redis?: Redis | undefined;
  google?: GoogleAuthDeps;
  emailInvitations?: boolean;
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
  google_link_required: 409,
  google_account_conflict: 409,
  privacy_acceptance_required: 400,
  privacy_version_changed: 409,
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

  app.get('/auth/privacy', { schema: { tags: ['auth'], summary: 'Aviso de privacidad vigente', ...noSession } }, async () => PRIVACY_NOTICE);
  app.post<{ Body: AcceptPrivacyRequest }>('/auth/privacy/accept', {
    preHandler: requireUser,
    // Se valida explícitamente: no convertir cadenas "true" en un consentimiento booleano.
    validatorCompiler: () => () => true,
    bodyLimit: AUTH_BODY_LIMIT,
    schema: { tags: ['auth'], summary: 'Registrar aceptación expresa de la versión vigente',
      body: { type: 'object', properties: { accepted: { type: 'boolean' }, version: { type: 'string' } } },
      response: { 200: wrap('user', 'User'), ...errors } },
  }, async (request) => {
    const body = objectBody(request);
    return { user: await service.acceptPrivacy(request.user!.id, { accepted: body.accepted, version: body.version }) };
  });

  app.get('/auth/providers', {
    schema: { tags: ['auth'], summary: 'Proveedores de inicio de sesión disponibles', ...noSession,
      response: { 200: { type: 'object', properties: { google: { type: 'boolean' }, emailInvitations: { type: 'boolean' } }, required: ['google', 'emailInvitations'] } } },
  }, async () => ({ google: Boolean(deps.google), emailInvitations: Boolean(deps.emailInvitations) }));

  const flowCookie = cookieSecure ? '__Host-pliego-google' : 'pliego-google';
  const flowCookieOptions = { path: '/', secure: cookieSecure, httpOnly: true, sameSite: 'lax' as const };
  const failure = (code: string) => `/entrar?modo=entrar&oauth_error=${code}`;

  app.get<{ Querystring: { volver?: string; link?: string } }>('/auth/google', {
    preHandler: limitAuth,
    schema: { tags: ['auth'], summary: 'Iniciar OAuth con Google', ...noSession },
  }, async (request, reply) => {
    const google = deps.google;
    if (!google) return reply.redirect(failure('google_unavailable'));
    try {
      const current = request.cookies[SESSION_COOKIE];
      const linkUser = request.query.link === '1' && current ? await service.getUserBySessionToken(current) : null;
      if (request.query.link === '1' && !linkUser) return reply.redirect(failure('google_link_required'));
      const state = googleRandom();
      const browser = googleRandom();
      const nonce = googleRandom();
      const verifier = googleRandom();
      await google.states.put(state, {
        browserHash: googleHash(browser), nonce, verifier, returnPath: googleReturnPath(request.query.volver),
        ...(linkUser ? { linkUserId: linkUser.id } : {}),
      });
      reply.setCookie(flowCookie, browser, { ...flowCookieOptions, signed: true, maxAge: GOOGLE_FLOW_SECONDS });
      return reply.redirect(google.provider.authorizationUrl(state, nonce, googleHash(verifier)));
    } catch {
      request.log.warn({ event: 'google_oauth_start_failed' }, 'No se pudo iniciar Google');
      return reply.redirect(failure('google_failed'));
    }
  });

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>('/auth/google/callback', {
    schema: { tags: ['auth'], summary: 'Retorno de Google OAuth', ...noSession },
  }, async (request, reply) => {
    reply.clearCookie(flowCookie, flowCookieOptions);
    const google = deps.google;
    if (!google) return reply.redirect(failure('google_unavailable'));
    try {
      const state = request.query.state;
      const signed = request.cookies[flowCookie];
      const browser = signed ? request.unsignCookie(signed) : null;
      if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state) || !browser?.valid || !browser.value) {
        return reply.redirect(failure('google_expired'));
      }
      const flow = await google.states.consume(state, googleHash(browser.value));
      if (!flow) return reply.redirect(failure('google_expired'));
      if (request.query.error) return reply.redirect(failure('google_cancelled'));
      const code = request.query.code;
      if (typeof code !== 'string' || !code || code.length > 4096) return reply.redirect(failure('google_failed'));
      if (flow.linkUserId) {
        const token = request.cookies[SESSION_COOKIE];
        const current = token ? await service.getUserBySessionToken(token) : null;
        if (!current || current.id !== flow.linkUserId) return reply.redirect(failure('google_expired'));
      }
      const identity = await google.provider.exchange(code, flow.verifier, flow.nonce);
      const session = await service.loginWithGoogle(identity, flow.linkUserId);
      await dropCurrentSession(request);
      return setSession(reply, session).redirect(flow.returnPath);
    } catch (error) {
      if (error instanceof AuthError && ['google_link_required', 'google_account_conflict'].includes(error.code)) {
        return reply.redirect(failure(error.code));
      }
      // Gaxios puede incluir el client secret y el code en sus errores: nunca registrar el objeto.
      request.log.warn({ event: 'google_oauth_callback_failed' }, 'No se pudo completar Google');
      return reply.redirect(failure('google_failed'));
    }
  });

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
