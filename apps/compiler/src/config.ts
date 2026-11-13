// Configuración de apps/compiler. Único lugar donde se lee process.env (ver CLAUDE.md).
// Los valores inválidos detienen el arranque con un mensaje claro, en lugar de fallar a mitad de
// una compilación.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_STORAGE_DIRNAME,
  envPositiveInteger,
  envPositiveNumber,
  envSize,
  type Env,
} from '@latexweb/shared';

export { ConfigError } from '@latexweb/shared';

export interface CompilerConfig {
  redisUrl: string;
  /** Raíz compartida con la API (COMPILE_STORAGE_DIR). */
  storageDir: string;
  image: string;
  timeoutSeconds: number;
  cpus: number;
  memory: string;
  pidsLimit: number;
  tmpfsSize: string;
  concurrency: number;
  ttlSeconds: number;
  sweepIntervalMs: number;
  maxPdfBytes: number;
  maxLogBytes: number;
}

const MB = 1024 * 1024;

export function loadConfig(env: Env = process.env): CompilerConfig {
  return {
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    storageDir: env.COMPILE_STORAGE_DIR ?? join(tmpdir(), DEFAULT_STORAGE_DIRNAME),
    image: env.COMPILE_IMAGE ?? 'latexweb-texlive:tl2026-1',
    timeoutSeconds: envPositiveInteger(env, 'COMPILE_TIMEOUT_SECONDS', 60),
    cpus: envPositiveNumber(env, 'COMPILE_CPUS', 1),
    memory: envSize(env, 'COMPILE_MEMORY', '1g'),
    pidsLimit: envPositiveInteger(env, 'COMPILE_PIDS_LIMIT', 128),
    tmpfsSize: envSize(env, 'COMPILE_TMPFS_SIZE', '256m'),
    concurrency: envPositiveInteger(env, 'COMPILE_CONCURRENCY', 2),
    ttlSeconds: envPositiveInteger(env, 'COMPILE_TTL_SECONDS', 3600),
    sweepIntervalMs: 10 * 60 * 1000,
    maxPdfBytes: envPositiveInteger(env, 'COMPILE_MAX_PDF_BYTES', 50 * MB),
    maxLogBytes: envPositiveInteger(env, 'COMPILE_MAX_LOG_BYTES', 5 * MB),
  };
}
