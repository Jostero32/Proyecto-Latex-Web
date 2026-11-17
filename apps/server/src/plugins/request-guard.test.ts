import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
  app.post('/echo', async () => ({ ok: true }));
  app.get('/echo', async () => ({ ok: true }));
});

afterEach(async () => {
  await app.close();
});

const forbidden = (error: string) => ({ error, message: expect.any(String) });

describe('guard de Host', () => {
  it.each(['evil.com', 'evil.com:3000', '127.0.0.1.evil.com'])('Host %s → 403 forbidden_host en GET /health', async (host) => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { host } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(forbidden('forbidden_host'));
  });

  it('Host evil.com también se rechaza en POST', async () => {
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { host: 'evil.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(forbidden('forbidden_host'));
  });

  it.each(['127.0.0.1:3000', 'localhost:3000', '[::1]:3000'])('Host %s → 200', async (host) => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { host } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('guard de Origin', () => {
  const host = '127.0.0.1:3000';

  it('POST con Origin http://evil.com → 403 forbidden_origin', async () => {
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { host, origin: 'http://evil.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(forbidden('forbidden_origin'));
  });

  it('POST con Origin null → 403 forbidden_origin', async () => {
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { host, origin: 'null' } });
    expect(res.statusCode).toBe(403);
  });

  it('POST sin Origin pasa el guard', async () => {
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { host } });
    expect(res.statusCode).toBe(200);
  });

  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])('POST con Origin permitido %s pasa el guard', async (origin) => {
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { host, origin } });
    expect(res.statusCode).toBe(200);
  });

  it('GET con Origin ajeno pasa (no modifica estado)', async () => {
    const res = await app.inject({ method: 'GET', url: '/echo', headers: { host, origin: 'http://evil.com' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('guard con configuración propia', () => {
  it('usa deps.security en lugar de los valores por defecto', async () => {
    const custom = await buildApp({
      security: { allowedHosts: ['app.example.com'], allowedOrigins: ['https://app.example.com'] },
    });
    try {
      custom.post('/echo', async () => ({ ok: true }));
      const ok = await custom.inject({
        method: 'POST', url: '/echo', headers: { host: 'app.example.com', origin: 'https://app.example.com' },
      });
      expect(ok.statusCode).toBe(200);
      const badHost = await custom.inject({ method: 'GET', url: '/health', headers: { host: '127.0.0.1:3000' } });
      expect(badHost.statusCode).toBe(403);
    } finally {
      await custom.close();
    }
  });
});
