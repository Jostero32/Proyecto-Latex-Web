import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const MB = 1024 * 1024;

describe('loadConfig', () => {
  it('valores por defecto', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(config.compilations).toEqual({
      storageDir: join(tmpdir(), 'latexweb-compilations'),
      upload: { maxFileBytes: 20 * MB, maxTotalBytes: 50 * MB, maxFiles: 200 },
      maxQueued: 50,
      ttlSeconds: 3600,
      maxPdfBytes: 50 * MB,
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
      COMPILE_STORAGE_DIR: '/data/x',
      COMPILE_MAX_UPLOAD_FILE_BYTES: '10',
      COMPILE_MAX_UPLOAD_TOTAL_BYTES: '20',
      COMPILE_MAX_UPLOAD_FILES: '3',
      COMPILE_MAX_QUEUED: '4',
      COMPILE_TTL_SECONDS: '5',
      COMPILE_MAX_PDF_BYTES: '6',
    });
    expect(config.port).toBe(8080);
    expect(config.redisUrl).toBe('redis://r:1');
    expect(config.compilations).toEqual({
      storageDir: '/data/x',
      upload: { maxFileBytes: 10, maxTotalBytes: 20, maxFiles: 3 },
      maxQueued: 4,
      ttlSeconds: 5,
      maxPdfBytes: 6,
    });
  });

  it.each([
    'SERVER_PORT',
    'COMPILE_MAX_UPLOAD_FILE_BYTES',
    'COMPILE_MAX_UPLOAD_TOTAL_BYTES',
    'COMPILE_MAX_UPLOAD_FILES',
    'COMPILE_MAX_QUEUED',
    'COMPILE_TTL_SECONDS',
    'COMPILE_MAX_PDF_BYTES',
  ])('%s inválida lanza ConfigError', (name) => {
    for (const value of ['abc', '0', '-1', '1.5']) {
      expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
    }
  });
});
