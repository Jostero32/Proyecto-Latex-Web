// Configuración de apps/compiler. Único lugar donde se lee process.env (ver CLAUDE.md).
// Los valores inválidos detienen el arranque con un mensaje claro, en lugar de fallar a mitad de
// una compilación.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STORAGE_DIRNAME } from '@latexweb/shared';

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

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompilerConfig {
  return {
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    storageDir: env.COMPILE_STORAGE_DIR ?? join(tmpdir(), DEFAULT_STORAGE_DIRNAME),
    image: env.COMPILE_IMAGE ?? 'latexweb-texlive:tl2026-1',
    timeoutSeconds: positiveInteger(env, 'COMPILE_TIMEOUT_SECONDS', 60),
    cpus: positiveNumber(env, 'COMPILE_CPUS', 1),
    memory: size(env, 'COMPILE_MEMORY', '1g'),
    pidsLimit: positiveInteger(env, 'COMPILE_PIDS_LIMIT', 128),
    tmpfsSize: size(env, 'COMPILE_TMPFS_SIZE', '256m'),
    concurrency: positiveInteger(env, 'COMPILE_CONCURRENCY', 2),
    ttlSeconds: positiveInteger(env, 'COMPILE_TTL_SECONDS', 3600),
    sweepIntervalMs: 10 * 60 * 1000,
    maxPdfBytes: positiveInteger(env, 'COMPILE_MAX_PDF_BYTES', 50 * MB),
    maxLogBytes: positiveInteger(env, 'COMPILE_MAX_LOG_BYTES', 5 * MB),
  };
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`${name} debe ser un entero positivo: "${raw}"`);
  return value;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} debe ser un número positivo: "${raw}"`);
  return value;
}

function size(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*[kmg]$/.test(raw)) throw new ConfigError(`${name} debe tener la forma 256m o 1g: "${raw}"`);
  return raw;
}
