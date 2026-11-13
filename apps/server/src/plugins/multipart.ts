// Registro de @fastify/multipart, compartido por los módulos que reciben archivos.
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { UploadLimits } from '../config';

/** Campos de texto admitidos además de los archivos (p. ej. mainFile y engine). */
const MAX_TEXT_FIELDS = 10;
/** Largo máximo de un campo de texto: rutas de hasta 255 caracteres con margen. */
const MAX_FIELD_BYTES = 1024;

export async function registerMultipart(app: FastifyInstance, limits: UploadLimits): Promise<void> {
  await app.register(multipart, {
    // Conserva la ruta relativa del filename ("figuras/a.png"); sin esto busboy la recorta al
    // nombre. Las rutas se validan después con normalizeProjectPath (verificado: llegan
    // también rutas como "../x" o "/etc/passwd").
    preservePath: true,
    limits: {
      fileSize: limits.maxFileBytes,
      files: limits.maxFiles,
      fields: MAX_TEXT_FIELDS,
      fieldSize: MAX_FIELD_BYTES,
      parts: limits.maxFiles + MAX_TEXT_FIELDS,
      headerPairs: 100,
    },
  });
}
