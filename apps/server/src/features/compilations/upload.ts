// Subida de un proyecto a compilar: lectura del multipart y validación.
// Ver docs/specs/compilacion.md, secciones "Validación" y "Subida".
import type { FastifyRequest } from 'fastify';
import {
  DEFAULT_ENGINE,
  DEFAULT_MAIN_FILE,
  detectEngineFromSource,
  findPathCollision,
  isEngine,
  isIgnoredPath,
  isValidMainFile,
  normalizeProjectPath,
  type CompilationErrorCode,
  type Engine,
} from '@latexweb/shared';
import type { UploadLimits } from '../../config';
import type { ProjectFile } from './storage';

export interface RawUpload {
  /** Archivos tal como llegaron: filename sin normalizar. */
  files: { filename: string; data: Buffer }[];
  mainFile?: string | undefined;
  engine?: string | undefined;
}

export interface ValidUpload {
  files: ProjectFile[];
  ignoredFiles: string[];
  mainFile: string;
  engine: Engine;
}

export class UploadError extends Error {
  override name = 'UploadError';
  constructor(
    readonly statusCode: 400 | 413 | 415,
    readonly code: CompilationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const FILE_FIELD = 'files';

/**
 * Lee el multipart completo en memoria (como máximo `maxTotalBytes`). Traduce los límites del
 * plugin a UploadError 413.
 */
export async function readUpload(request: FastifyRequest, limits: UploadLimits): Promise<RawUpload> {
  if (!request.isMultipart()) {
    throw new UploadError(415, 'invalid_request', 'Se espera multipart/form-data');
  }

  const upload: RawUpload = { files: [] };
  let totalBytes = 0;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== FILE_FIELD) {
          throw new UploadError(400, 'invalid_request', `Los archivos van en el campo "${FILE_FIELD}", no en "${part.fieldname}"`);
        }
        const data = await part.toBuffer();
        totalBytes += data.length;
        if (totalBytes > limits.maxTotalBytes) {
          throw new UploadError(413, 'payload_too_large', `El proyecto supera ${limits.maxTotalBytes} bytes en total`);
        }
        upload.files.push({ filename: part.filename, data });
      } else if (part.fieldname === 'mainFile' || part.fieldname === 'engine') {
        if (typeof part.value !== 'string') {
          throw new UploadError(400, 'invalid_request', `El campo "${part.fieldname}" debe ser texto`);
        }
        // busboy trunca en silencio los campos que superan fieldSize.
        if (part.valueTruncated) {
          throw new UploadError(400, 'invalid_request', `El campo "${part.fieldname}" es demasiado largo`);
        }
        upload[part.fieldname] = part.value;
      }
      // Otros campos de texto se ignoran.
    }
  } catch (error) {
    throw toUploadError(error, limits);
  }
  return upload;
}

/** Valida y normaliza lo subido. Función pura: no toca el disco. */
export function validateUpload(raw: RawUpload): ValidUpload {
  if (raw.files.length === 0) throw new UploadError(400, 'no_files', 'No se envió ningún archivo');

  const files: ProjectFile[] = [];
  const ignoredFiles: string[] = [];
  for (const file of raw.files) {
    const check = normalizeProjectPath(file.filename);
    if (!check.ok) {
      throw new UploadError(400, 'invalid_path', `Ruta inválida (${check.reason}): ${JSON.stringify(file.filename)}`);
    }
    if (isIgnoredPath(check.path)) ignoredFiles.push(check.path);
    else files.push({ path: check.path, data: file.data });
  }

  const collision = findPathCollision(files.map((f) => f.path));
  if (collision) {
    throw new UploadError(
      400,
      'duplicate_path',
      collision.kind === 'duplicate'
        ? `Archivo duplicado: "${collision.path}" y "${collision.conflictsWith}"`
        : `"${collision.conflictsWith}" es un archivo y también una carpeta en "${collision.path}"`,
    );
  }
  if (files.length === 0) throw new UploadError(400, 'no_files', 'Todos los archivos enviados se ignoraron');

  const mainFile = raw.mainFile === undefined || raw.mainFile === '' ? DEFAULT_MAIN_FILE : raw.mainFile;
  if (!isValidMainFile(mainFile)) {
    throw new UploadError(400, 'invalid_main_file', `Documento principal inválido: ${JSON.stringify(mainFile)}`);
  }
  const main = files.find((f) => f.path === mainFile);
  if (!main) throw new UploadError(400, 'main_file_missing', `Falta el documento principal "${mainFile}"`);

  let engine: Engine;
  if (raw.engine !== undefined && raw.engine !== '') {
    if (!isEngine(raw.engine)) throw new UploadError(400, 'invalid_engine', `Motor inválido: ${JSON.stringify(raw.engine)}`);
    engine = raw.engine;
  } else {
    engine = detectEngineFromSource(main.data.toString('utf8')) ?? DEFAULT_ENGINE;
  }

  return { files, ignoredFiles, mainFile, engine };
}

function toUploadError(error: unknown, limits: UploadLimits): unknown {
  if (error instanceof UploadError) return error;
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'FST_REQ_FILE_TOO_LARGE':
      return new UploadError(413, 'file_too_large', `Un archivo supera ${limits.maxFileBytes} bytes`);
    case 'FST_FILES_LIMIT':
      return new UploadError(413, 'too_many_files', `Se admiten como máximo ${limits.maxFiles} archivos`);
    case 'FST_PARTS_LIMIT':
    case 'FST_FIELDS_LIMIT':
      return new UploadError(413, 'too_many_files', 'Demasiadas partes en el formulario');
    case 'FST_PROTO_VIOLATION':
    case 'FST_INVALID_MULTIPART_CONTENT_TYPE':
    case 'FST_MP_PREMATURE_CLOSE':
      return new UploadError(400, 'invalid_request', 'Formulario multipart inválido');
    default:
      return error;
  }
}
