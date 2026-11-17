// Configuración de apps/server. Único lugar donde se lee process.env (ver CLAUDE.md).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STORAGE_DIRNAME, envPositiveInteger, type Env } from '@latexweb/shared';

export { ConfigError } from '@latexweb/shared';

export interface UploadLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export interface CompilationsConfig {
  /** Raíz compartida con el worker (COMPILE_STORAGE_DIR); el mismo valor por defecto que el worker. */
  storageDir: string;
  upload: UploadLimits;
  /** Si hay más trabajos esperando, POST responde 503. */
  maxQueued: number;
  ttlSeconds: number;
  /** Solo para informar el límite en el error pdf_too_large; el que lo aplica es el worker. */
  maxPdfBytes: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  redisUrl: string;
  compilations: CompilationsConfig;
}

const MB = 1024 * 1024;

export function loadConfig(env: Env = process.env): ServerConfig {
  return {
    // Por defecto solo localhost. En docker compose es 0.0.0.0 dentro del contenedor, y compose lo
    // publica solo en 127.0.0.1 del host (ver docs/specs/docker-compose.md).
    host: env.SERVER_HOST === undefined || env.SERVER_HOST === '' ? '127.0.0.1' : env.SERVER_HOST,
    port: envPositiveInteger(env, 'SERVER_PORT', 3000),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    compilations: {
      storageDir: env.COMPILE_STORAGE_DIR ?? join(tmpdir(), DEFAULT_STORAGE_DIRNAME),
      upload: {
        maxFileBytes: envPositiveInteger(env, 'COMPILE_MAX_UPLOAD_FILE_BYTES', 20 * MB),
        maxTotalBytes: envPositiveInteger(env, 'COMPILE_MAX_UPLOAD_TOTAL_BYTES', 50 * MB),
        maxFiles: envPositiveInteger(env, 'COMPILE_MAX_UPLOAD_FILES', 200),
      },
      maxQueued: envPositiveInteger(env, 'COMPILE_MAX_QUEUED', 50),
      ttlSeconds: envPositiveInteger(env, 'COMPILE_TTL_SECONDS', 3600),
      maxPdfBytes: envPositiveInteger(env, 'COMPILE_MAX_PDF_BYTES', 50 * MB),
    },
  };
}
