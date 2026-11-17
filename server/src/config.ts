// Configuración de server. Único lugar donde se lee process.env (ver CLAUDE.md).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STORAGE_DIRNAME, envPositiveInteger, type Env } from '@latexweb/shared';
import type { ProjectLimits } from './features/files/service';
import { DEFAULT_ALLOWED_HOSTS, DEFAULT_ALLOWED_ORIGINS, type RequestGuardOptions } from './http';
import type { StorageConfig } from './storage';

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
  /** Subidas leyéndose a la vez (cada una ocupa hasta ~maxTotalBytes de memoria). Por defecto 4. */
  maxConcurrentUploads?: number;
  /** Si queda menos espacio libre en la raíz, POST responde 507. Por defecto no se comprueba. */
  minFreeBytes?: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  redisUrl: string;
  databaseUrl: string;
  /** Cookie de sesión con el atributo Secure (obligatorio en producción, con HTTPS). */
  cookieSecure: boolean;
  /** Timeout para recibir una petición completa (contra subidas lentas tipo slowloris). */
  requestTimeoutMs: number;
  security: RequestGuardOptions;
  /** MinIO (S3): binarios de los proyectos. */
  storage: StorageConfig;
  projects: ProjectLimits;
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
    databaseUrl: env.DATABASE_URL ?? 'postgresql://latexweb:latexweb@127.0.0.1:5432/latexweb',
    cookieSecure: env.COOKIE_SECURE === 'true',
    requestTimeoutMs: envPositiveInteger(env, 'SERVER_REQUEST_TIMEOUT_MS', 120_000),
    security: {
      allowedOrigins: list(env.ALLOWED_ORIGINS) ?? DEFAULT_ALLOWED_ORIGINS,
      allowedHosts: list(env.ALLOWED_HOSTS) ?? DEFAULT_ALLOWED_HOSTS,
    },
    storage: {
      endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      region: env.S3_REGION ?? 'us-east-1',
      accessKey: env.S3_ACCESS_KEY ?? 'latexweb',
      secretKey: env.S3_SECRET_KEY ?? 'latexweb-dev-secret',
      bucket: env.S3_BUCKET ?? 'latexweb',
    },
    projects: {
      maxBytes: envPositiveInteger(env, 'PROJECT_MAX_BYTES', 200 * MB),
      maxFiles: envPositiveInteger(env, 'PROJECT_MAX_FILES', 500),
      fileMaxBytes: envPositiveInteger(env, 'FILE_MAX_BYTES', 50 * MB),
      docMaxBytes: envPositiveInteger(env, 'DOC_MAX_BYTES', 10 * MB),
    },
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
      maxConcurrentUploads: envPositiveInteger(env, 'COMPILE_MAX_CONCURRENT_UPLOADS', 4),
      minFreeBytes: envPositiveInteger(env, 'COMPILE_MIN_FREE_BYTES', 1024 * MB),
    },
  };
}

/** Lista separada por comas; ausente o vacía → undefined (se usa el valor por defecto). */
function list(raw: string | undefined): string[] | undefined {
  const items = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
