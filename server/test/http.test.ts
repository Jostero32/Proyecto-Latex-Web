// Guardas HTTP de toda la API: Host (contra DNS rebinding) y Origin en métodos que modifican estado.
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hostName, isAllowedOrigin } from '../src/http';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
  app.post('/echo', async () => ({ ok: true }));
});

afterEach(async () => {
  await app.close();
});

describe('guardas de Host y Origin', () => {
  it.each(['evil.com', '127.0.0.1.evil.com'])('Host %s → 403 forbidden_host', async (host) => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_host', message: expect.any(String) });
  });

  it('acepta los hosts locales con puerto', async () => {
    for (const host of ['127.0.0.1:53000', 'localhost:53000', '[::1]:53000']) {
      expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('un POST con Origin ajeno o null → 403; permitido o sin Origin pasa; un GET no se mira', async () => {
    const post = (origin?: string) => app.inject({ method: 'POST', url: '/echo', headers: origin ? { origin } : {} });
    expect((await post('http://evil.com')).json()).toMatchObject({ error: 'forbidden_origin' });
    expect((await post('null')).statusCode).toBe(403);
    expect((await post('http://localhost:55173')).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://evil.com' } });
    expect(get.statusCode).toBe(200);
  });

  it('acepta el mismo origen que el server (Swagger UI en /api/docs), pero no otro puerto', async () => {
    const post = (origin: string) => app.inject({ method: 'POST', url: '/echo', headers: { host: '127.0.0.1:53000', origin } });
    expect((await post('http://127.0.0.1:53000')).statusCode).toBe(200);
    expect((await post('http://127.0.0.1:4000')).statusCode).toBe(403);
  });

  it('usa la configuración propia en lugar de los valores por defecto', async () => {
    const custom = await buildApp({ security: { allowedOrigins: ['https://app.ejemplo.com'], allowedHosts: ['app.ejemplo.com'] } });
    try {
      expect((await custom.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:53000' } })).statusCode).toBe(403);
      expect((await custom.inject({ method: 'GET', url: '/api/health', headers: { host: 'app.ejemplo.com' } })).statusCode).toBe(200);
    } finally {
      await custom.close();
    }
  });

  it.each<[string | undefined, string | null]>([
    ['LOCALHOST:55173', 'localhost'],
    ['[::1]:53000', '[::1]'],
    ['[::1]x', null],
    ['host:99999999', null],
    ['a b', null],
    [undefined, null],
  ])('hostName(%j) = %j', (input, expected) => {
    expect(hostName(input)).toBe(expected);
  });

  it('el Origin se compara exacto, sin barra final ni mayúsculas', () => {
    const options = { allowedOrigins: ['http://localhost:55173'], allowedHosts: [] };
    expect(isAllowedOrigin('HTTP://LOCALHOST:55173/', options)).toBe(true);
    expect(isAllowedOrigin('http://localhost:55174', options)).toBe(false);
    expect(isAllowedOrigin('http://localhost:55173.evil.com', options)).toBe(false);
  });
});
