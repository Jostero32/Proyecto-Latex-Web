// Tests de loadConfig: valores por defecto, lectura del entorno y validación.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const MB = 1024 * 1024;

describe('valores por defecto', () => {
  it('con un env vacío', () => {
    expect(loadConfig({})).toMatchObject({
      redisUrl: 'redis://127.0.0.1:6379',
      storageDir: join(tmpdir(), 'latexweb-compilations'),
      image: 'latexweb-texlive:tl2026-2',
      timeoutSeconds: 60,
      cpus: 1,
      memory: '1g',
      pidsLimit: 128,
      tmpfsSize: '256m',
      concurrency: 2,
      ttlSeconds: 3600,
      maxPdfBytes: 50 * MB,
      maxLogBytes: 5 * MB,
      storageVolume: undefined,
    });
  });

  it('una variable vacía usa el valor por defecto', () => {
    const config = loadConfig({
      COMPILE_TIMEOUT_SECONDS: '',
      COMPILE_CPUS: '',
      COMPILE_MEMORY: '',
      COMPILE_TMPFS_SIZE: '',
      COMPILE_PIDS_LIMIT: '',
      COMPILE_CONCURRENCY: '',
      COMPILE_TTL_SECONDS: '',
      COMPILE_MAX_PDF_BYTES: '',
      COMPILE_MAX_LOG_BYTES: '',
    });
    expect(config).toMatchObject({
      timeoutSeconds: 60,
      cpus: 1,
      memory: '1g',
      tmpfsSize: '256m',
      pidsLimit: 128,
      concurrency: 2,
      ttlSeconds: 3600,
      maxPdfBytes: 50 * MB,
      maxLogBytes: 5 * MB,
    });
  });
});

describe('COMPILE_STORAGE_VOLUME', () => {
  it('definida: se lee en storageVolume', () => {
    expect(loadConfig({ COMPILE_STORAGE_VOLUME: 'latexweb-compile-storage' }).storageVolume).toBe('latexweb-compile-storage');
  });

  it('ausente: storageVolume es undefined', () => {
    expect(loadConfig({}).storageVolume).toBeUndefined();
  });

  it('vacía: storageVolume es undefined', () => {
    expect(loadConfig({ COMPILE_STORAGE_VOLUME: '' }).storageVolume).toBeUndefined();
  });
});

describe('lectura del entorno', () => {
  it('lee cada variable', () => {
    const config = loadConfig({
      REDIS_URL: 'redis://cola:6380',
      COMPILE_STORAGE_DIR: '/data/compilaciones',
      COMPILE_IMAGE: 'otra:1',
      COMPILE_TIMEOUT_SECONDS: '30',
      COMPILE_CPUS: '0.5',
      COMPILE_MEMORY: '512m',
      COMPILE_PIDS_LIMIT: '64',
      COMPILE_TMPFS_SIZE: '2g',
      COMPILE_CONCURRENCY: '4',
      COMPILE_TTL_SECONDS: '120',
      COMPILE_MAX_PDF_BYTES: '1000',
      COMPILE_MAX_LOG_BYTES: '2000',
    });
    expect(config).toMatchObject({
      redisUrl: 'redis://cola:6380',
      storageDir: '/data/compilaciones',
      image: 'otra:1',
      timeoutSeconds: 30,
      cpus: 0.5,
      memory: '512m',
      pidsLimit: 64,
      tmpfsSize: '2g',
      concurrency: 4,
      ttlSeconds: 120,
      maxPdfBytes: 1000,
      maxLogBytes: 2000,
    });
  });
});

describe('validación', () => {
  const integerVars = [
    'COMPILE_TIMEOUT_SECONDS',
    'COMPILE_PIDS_LIMIT',
    'COMPILE_CONCURRENCY',
    'COMPILE_TTL_SECONDS',
    'COMPILE_MAX_PDF_BYTES',
    'COMPILE_MAX_LOG_BYTES',
  ];
  const integerCases = integerVars.flatMap((name) => ['0', '-1', '1.5', 'abc'].map((value) => [name, value] as const));

  it.each(integerCases)('%s = %j lanza ConfigError', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
  });

  it.each(['0', 'abc', '-1'])('COMPILE_CPUS = %j lanza ConfigError', (value) => {
    expect(() => loadConfig({ COMPILE_CPUS: value })).toThrow(ConfigError);
  });

  it('COMPILE_CPUS acepta 0.5', () => {
    expect(loadConfig({ COMPILE_CPUS: '0.5' }).cpus).toBe(0.5);
  });

  const sizeCases = ['COMPILE_MEMORY', 'COMPILE_TMPFS_SIZE'].flatMap((name) =>
    ['1G', '256', '0m', 'm', '-1m'].map((value) => [name, value] as const),
  );

  it.each(sizeCases)('%s = %j lanza ConfigError', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
  });

  it('el mensaje del error nombra la variable', () => {
    expect(() => loadConfig({ COMPILE_MEMORY: '1G' })).toThrow(/COMPILE_MEMORY/);
  });
});
