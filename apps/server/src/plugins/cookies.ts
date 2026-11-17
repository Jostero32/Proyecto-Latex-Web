// Parseo y emisión de cookies (@fastify/cookie), compartido por las funcionalidades.
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';

export async function registerCookies(app: FastifyInstance): Promise<void> {
  // Sin firma: la cookie de sesión es un token aleatorio de 32 bytes que solo vale si existe en la base.
  await app.register(cookie);
}
