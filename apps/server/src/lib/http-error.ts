// Respuestas de error con la forma { error, message } (ver docs/specs/compilacion.md, "Endpoints").
import type { FastifyReply } from 'fastify';

export function sendError<Code extends string>(
  reply: FastifyReply,
  statusCode: number,
  error: Code,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({ error, message });
}
