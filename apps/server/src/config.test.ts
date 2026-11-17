import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import { DEFAULT_ALLOWED_HOSTS, DEFAULT_ALLOWED_ORIGINS } from './lib/request-guard';

const MB = 1024 * 1024;

describe('loadConfig', () => {
  it('valores por defecto', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(config.requestTimeoutMs).toBe(120_000);
    expect(config.security).toEqual({
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
    });
    expect(config.compilations).toEqual({
      storageDir: join(tmpdir(), 'latexweb-compilations'),
      upload: { maxFileBytes: 20 * MB, maxTotalBytes: 50 * MB, maxFiles: 200 },
      maxQueued: 50,
      ttlSeconds: 3600,
      maxPdfBytes: 50 * MB,
      maxConcurrentUploads: 4,
      minFreeBytes: 1024 * MB,
    });
  });

  it('SERVER_HOST vacía usa 127.0.0.1', () => {
    expect(loadConfig({ SERVER_HOST: '' }).host).toBe('127.0.0.1');
  });

  it('SERVER_HOST=0.0.0.0 se respeta', () => {
    expect(loadConfig({ SERVER_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('lee cada variable', () => {
    const config = loadConfig({
      SERVER_PORT: '8080',
      REDIS_URL: 'redis://r:1',
      SERVER_REQUEST_TIMEOUT_MS: '9000',
      COMPILE_STORAGE_DIR: '/data/x',
      COMPILE_MAX_UPLOAD_FILE_BYTES: '10',
      COMPILE_MAX_UPLOAD_TOTAL_BYTES: '20',
      COMPILE_MAX_UPLOAD_FILES: '3',
      COMPILE_MAX_QUEUED: '4',
      COMPILE_TTL_SECONDS: '5',
      COMPILE_MAX_PDF_BYTES: '6',
      COMPILE_MAX_CONCURRENT_UPLOADS: '7',
      COMPILE_MIN_FREE_BYTES: '8',
    });
    expect(config.port).toBe(8080);
    expect(config.redisUrl).toBe('redis://r:1');
    expect(config.requestTimeoutMs).toBe(9000);
    expect(config.compilations).toEqual({
      storageDir: '/data/x',
      upload: { maxFileBytes: 10, maxTotalBytes: 20, maxFiles: 3 },
      maxQueued: 4,
      ttlSeconds: 5,
      maxPdfBytes: 6,
      maxConcurrentUploads: 7,
      minFreeBytes: 8,
    });
  });

  it('ALLOWED_ORIGINS y ALLOWED_HOSTS: lista separada por comas, con espacios', () => {
    const config = loadConfig({
      ALLOWED_ORIGINS: ' https://app.example.com , http://localhost:4000,',
      ALLOWED_HOSTS: 'app.example.com ,  localhost',
    });
    expect(config.security.allowedOrigins).toEqual(['https://app.example.com', 'http://localhost:4000']);
    expect(config.security.allowedHosts).toEqual(['app.example.com', 'localhost']);
  });

  it.each(['', '  ', ' , ,'])('ALLOWED_ORIGINS y ALLOWED_HOSTS vacías (%j) usan los valores por defecto', (value) => {
    const config = loadConfig({ ALLOWED_ORIGINS: value, ALLOWED_HOSTS: value });
    expect(config.security.allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(config.security.allowedHosts).toEqual(DEFAULT_ALLOWED_HOSTS);
  });

  it.each([
    'SERVER_PORT',
    'SERVER_REQUEST_TIMEOUT_MS',
    'COMPILE_MAX_UPLOAD_FILE_BYTES',
    'COMPILE_MAX_UPLOAD_TOTAL_BYTES',
    'COMPILE_MAX_UPLOAD_FILES',
    'COMPILE_MAX_QUEUED',
    'COMPILE_TTL_SECONDS',
    'COMPILE_MAX_PDF_BYTES',
    'COMPILE_MAX_CONCURRENT_UPLOADS',
    'COMPILE_MIN_FREE_BYTES',
  ])('%s inválida lanza ConfigError', (name) => {
    for (const value of ['abc', '0', '-1', '1.5']) {
      expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
    }
  });
});
