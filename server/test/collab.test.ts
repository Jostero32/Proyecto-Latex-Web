// Colaboración: Hocuspocus en el mismo puerto que la API y protecciones del upgrade (Host, Origin,
// URLs inválidas). Hasta el paso 3 de docs/specs/backend.md /collab rechaza toda conexión con 401;
// ahí vuelven los tests de sincronización, tamaño de mensaje y cierre.
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { COLLAB_PATH } from '../src/features/collab/websocket';

let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
});

/**
 * Manda una petición de upgrade cruda y devuelve la primera línea de la respuesta. `headers`
 * reemplaza o agrega cabeceras (valor `null` = omitir); por defecto, Host: el del servidor.
 */
function rawUpgrade(target: string, headers: Record<string, string | null> = {}): Promise<string> {
  return new Promise((resolve) => {
    const [host, port] = base.split(':');
    const merged: Record<string, string | null> = {
      Host: base,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      ...headers,
    };
    const head = Object.entries(merged)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    const socket = connect(Number(port), host ?? '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\n${head}\r\n`);
    });
    let response = '';
    const finish = () => {
      socket.destroy();
      resolve(response.split('\r\n')[0] ?? '');
    };
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
      if (response.includes('\r\n')) finish();
    });
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

describe('colaboración', () => {
  it('comparte puerto con la API; solo /collab es un upgrade válido, y por ahora sin aceptar conexiones', async () => {
    expect((await fetch(`http://${base}/api/health`)).status).toBe(200);
    expect(await rawUpgrade(COLLAB_PATH, { Origin: 'http://localhost:5173' })).toBe('HTTP/1.1 401 Unauthorized');
    expect(await rawUpgrade(COLLAB_PATH)).toBe('HTTP/1.1 401 Unauthorized');
    for (const path of ['/', '/api/health', '/collab/otro']) expect(await rawUpgrade(path)).toBe('HTTP/1.1 404 Not Found');
  });

  it('rechaza el upgrade con un Host o un Origin ajenos', async () => {
    expect(await rawUpgrade(COLLAB_PATH, { Host: 'evil.com', Origin: 'http://localhost:5173' })).toBe('HTTP/1.1 403 Forbidden');
    for (const origin of ['http://evil.com', 'null']) {
      expect(await rawUpgrade(COLLAB_PATH, { Origin: origin })).toBe('HTTP/1.1 403 Forbidden');
    }
  });

  // Regresión: `new URL()` lanzaba fuera del try y la promesa rechazada terminaba el proceso.
  it.each(['//%', 'http://['])('una URL ilegible (%s) da 400 y el servidor sigue respondiendo', async (target) => {
    expect(await rawUpgrade(target, { Host: 'x' })).toBe('HTTP/1.1 400 Bad Request');
    expect((await fetch(`http://${base}/api/health`)).status).toBe(200);
  });
});
