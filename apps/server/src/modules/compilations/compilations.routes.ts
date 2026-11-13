// Rutas /compilations. Ver docs/specs/compilacion.md, "Endpoints".
import { randomUUID } from 'node:crypto';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { CompilationErrorCode, CreateCompilationResponse } from '@latexweb/shared';
import type { CompilationsConfig } from '../../config';
import { sendError } from '../../lib/http-error';
import type { CompileQueue } from './compilations.queue';
import type { CompilationsStorage } from './compilations.storage';
import { readUpload, UploadError, validateUpload } from './compilations.upload';

export interface CompilationsDeps {
  queue: CompileQueue;
  storage: CompilationsStorage;
  config: CompilationsConfig;
}

/** Segundos sugeridos al cliente para reintentar cuando la cola está llena o no responde. */
const RETRY_AFTER_SECONDS = 30;

export async function compilationsRoutes(app: FastifyInstance, deps: CompilationsDeps): Promise<void> {
  const { queue, storage, config } = deps;
  const fail = (reply: Parameters<typeof sendError>[0], status: number, code: CompilationErrorCode, message: string) =>
    sendError(reply, status, code, message);

  // Todas las respuestas de error del módulo con la forma { error, message } de la spec, incluidas
  // las que genera Fastify antes del handler. Los 5xx nunca exponen el mensaje interno (puede
  // contener rutas del servidor): el detalle va solo al log.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'error interno en /compilations');
      return fail(reply, 500, 'internal_error', 'Error interno del servidor');
    }
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return fail(reply, 415, 'invalid_request', 'Se espera multipart/form-data');
    }
    if (status === 413) return fail(reply, 413, 'payload_too_large', 'La petición es demasiado grande');
    return fail(reply, status, 'invalid_request', 'Petición inválida');
  });

  app.post('/compilations', async (request, reply) => {
    // Rechazo barato antes de leer el cuerpo: cola llena o Redis caído.
    try {
      if ((await queue.waitingCount()) >= config.maxQueued) {
        reply.header('Retry-After', String(RETRY_AFTER_SECONDS));
        return fail(reply, 503, 'queue_full', 'Hay demasiadas compilaciones en espera; reintenta en unos segundos');
      }
    } catch (error) {
      request.log.error({ err: error }, 'no se pudo consultar la cola de compilación');
      reply.header('Retry-After', String(RETRY_AFTER_SECONDS));
      return fail(reply, 503, 'queue_full', 'El servicio de compilación no está disponible');
    }

    let upload;
    try {
      upload = validateUpload(await readUpload(request, config.upload));
    } catch (error) {
      if (error instanceof UploadError) return fail(reply, error.statusCode, error.code, error.message);
      throw error;
    }

    const id = randomUUID();
    await storage.saveInputs(id, upload.files);
    try {
      await queue.add({ compilationId: id, mainFile: upload.mainFile, engine: upload.engine });
    } catch (error) {
      request.log.error({ err: error, compilationId: id }, 'no se pudo encolar la compilación');
      await storage.remove(id).catch((removeError: unknown) =>
        request.log.error({ err: removeError, compilationId: id }, 'no se pudieron borrar los archivos'),
      );
      reply.header('Retry-After', String(RETRY_AFTER_SECONDS));
      return fail(reply, 503, 'queue_full', 'El servicio de compilación no está disponible');
    }

    const body: CreateCompilationResponse = {
      id,
      status: 'queued',
      engine: upload.engine,
      mainFile: upload.mainFile,
      ignoredFiles: upload.ignoredFiles,
    };
    return reply.code(202).header('Location', `/compilations/${id}`).send(body);
  });
}
