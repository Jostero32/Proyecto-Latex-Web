// Rutas /compilations. Ver docs/specs/compilacion.md, "Endpoints".
import { randomUUID } from 'node:crypto';
import type { FastifyError, FastifyInstance } from 'fastify';
import {
  isCompilationId,
  type ArtifactKind,
  type CompilationErrorCode,
  type CreateCompilationResponse,
} from '@latexweb/shared';
import type { CompilationsConfig } from '../../config';
import { sendError } from '../../lib/http-error';
import type { CompileQueue } from './queue';
import { artifactAvailability, buildStatusResponse, type ArtifactErrorCode } from './status';
import type { CompilationsStorage } from './storage';
import { readUpload, UploadError, validateUpload } from './upload';

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
    try {
      await storage.saveInputs(id, upload.files);
    } catch (error) {
      // Nunca dejar un proyecto a medio escribir (si no, se podrían acumular datos sin pasar por la cola).
      await storage.remove(id).catch((removeError: unknown) =>
        request.log.error({ err: removeError, compilationId: id }, 'no se pudieron borrar los archivos'),
      );
      // Colisión que el sistema de archivos detecta y la validación no (p. ej. alias 8.3 o
      // mayúsculas en NTFS): es un error del cliente.
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return fail(reply, 400, 'duplicate_path', 'Dos archivos del proyecto apuntan al mismo nombre en disco');
      }
      throw error;
    }
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

  app.get<{ Params: { id: string } }>('/compilations/:id', async (request, reply) => {
    const { id } = request.params;
    // El id se valida antes de tocar Redis o el disco.
    if (!isCompilationId(id)) return fail(reply, 404, 'not_found', 'No existe la compilación');
    const job = await queue.get(id);
    if (!job) return fail(reply, 404, 'not_found', 'No existe la compilación');
    return reply.header('Cache-Control', 'no-store').send(buildStatusResponse(id, job, config.ttlSeconds));
  });

  for (const kind of ['pdf', 'log'] as const satisfies readonly ArtifactKind[]) {
    app.get<{ Params: { id: string } }>(`/compilations/:id/${kind}`, async (request, reply) => {
      const { id } = request.params;
      if (!isCompilationId(id)) return fail(reply, 404, 'not_found', 'No existe la compilación');
      const job = await queue.get(id);
      if (!job) return fail(reply, 404, 'not_found', 'No existe la compilación');

      const availability = artifactAvailability(job, kind, config.ttlSeconds);
      if (!availability.available) {
        return fail(reply, availability.statusCode, availability.code, ARTIFACT_MESSAGES[availability.code](config));
      }

      const artifact = await storage.openArtifact(id, kind);
      // El job existe pero el archivo ya no: lo borró el barrido al vencer el TTL.
      if (!artifact) return fail(reply, 410, 'expired', ARTIFACT_MESSAGES.expired(config));

      // Contenido generado por el usuario: nunca se interpreta como HTML ni ejecuta scripts.
      return reply
        .header('Content-Type', kind === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8')
        .header('Content-Length', String(artifact.size))
        .header('Content-Disposition', `inline; filename="output.${kind}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', 'sandbox')
        .header('Cache-Control', 'private, no-store')
        .send(artifact.stream);
    });
  }
}

const ARTIFACT_MESSAGES: Record<ArtifactErrorCode, (config: CompilationsConfig) => string> = {
  not_ready: () => 'La compilación todavía no terminó',
  artifact_not_available: () => 'La compilación no generó este archivo',
  pdf_too_large: (config) => `El PDF superó el tamaño máximo de ${config.maxPdfBytes} bytes y no se guardó`,
  expired: () => 'El archivo ya no está disponible: venció el tiempo de retención',
};
