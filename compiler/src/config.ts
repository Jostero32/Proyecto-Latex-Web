// Configuración de compiler. Único lugar donde se lee process.env (ver CLAUDE.md).
// Los valores inválidos detienen el arranque con un mensaje claro, en lugar de fallar a mitad de
// una compilación.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envPositiveInteger, envPositiveNumber, envSize, type Env } from '@latexweb/shared';
import type { StorageConfig } from './storage';

export { ConfigError } from '@latexweb/shared';

export interface CompilerConfig {
  redisUrl: string;
  /** MinIO: de ahí se baja la instantánea del proyecto y ahí se suben los artefactos. */
  storage: StorageConfig;
  /** Disco de trabajo propio del worker (COMPILE_WORK_DIR); por defecto, en el directorio temporal. */
  workDir: string;
  /**
   * COMPILE_WORK_VOLUME: si está definida, el worker corre en un contenedor (docker compose) y
   * workDir es el punto de montaje de este volumen; las compilaciones lo montan con subpath.
   */
  workVolume: string | undefined;
  image: string;
  timeoutSeconds: number;
  cpus: number;
  memory: string;
  pidsLimit: number;
  tmpfsSize: string;
  concurrency: number;
  sweepIntervalMs: number;
  maxPdfBytes: number;
  maxLogBytes: number;
  /** Topes de la instantánea que se baja; los mismos que el server aplica a un proyecto. */
  maxInputBytes: number;
  maxInputFiles: number;
  /** COMPILE_MIN_FREE_BYTES: con menos espacio libre en el disco de trabajo, los jobs fallan sin compilar. */
  minFreeBytes: number;
}

const MB = 1024 * 1024;

export function loadConfig(env: Env = process.env): CompilerConfig {
  return {
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:56379',
    storage: {
      endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:59000',
      region: env.S3_REGION ?? 'us-east-1',
      accessKey: env.S3_ACCESS_KEY ?? 'latexweb',
      secretKey: env.S3_SECRET_KEY ?? 'latexweb-dev-secret',
      bucket: env.S3_BUCKET ?? 'latexweb',
    },
    workDir: env.COMPILE_WORK_DIR || join(tmpdir(), 'latexweb-compile-work'),
    workVolume: env.COMPILE_WORK_VOLUME === '' ? undefined : env.COMPILE_WORK_VOLUME,
    image: env.COMPILE_IMAGE ?? 'latexweb-texlive:tl2026-2',
    timeoutSeconds: envPositiveInteger(env, 'COMPILE_TIMEOUT_SECONDS', 60),
    cpus: envPositiveNumber(env, 'COMPILE_CPUS', 1),
    memory: envSize(env, 'COMPILE_MEMORY', '1g'),
    pidsLimit: envPositiveInteger(env, 'COMPILE_PIDS_LIMIT', 128),
    tmpfsSize: envSize(env, 'COMPILE_TMPFS_SIZE', '256m'),
    concurrency: envPositiveInteger(env, 'COMPILE_CONCURRENCY', 2),
    sweepIntervalMs: 10 * 60 * 1000,
    maxPdfBytes: envPositiveInteger(env, 'COMPILE_MAX_PDF_BYTES', 50 * MB),
    maxLogBytes: envPositiveInteger(env, 'COMPILE_MAX_LOG_BYTES', 5 * MB),
    maxInputBytes: envPositiveInteger(env, 'PROJECT_MAX_BYTES', 200 * MB),
    maxInputFiles: envPositiveInteger(env, 'PROJECT_MAX_FILES', 500),
    minFreeBytes: envPositiveInteger(env, 'COMPILE_MIN_FREE_BYTES', 1024 * MB),
  };
}
