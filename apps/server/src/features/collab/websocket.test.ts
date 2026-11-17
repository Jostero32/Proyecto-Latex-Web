import type { AddressInfo } from 'node:net';
import { connect as connect_ } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildApp } from '../../app';
import { COLLAB_MAX_MESSAGE_BYTES, COLLAB_PATH } from './websocket';

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

/** Abre un WebSocket y resuelve con 'open' o con 'error' si el servidor rechaza el upgrade. */
function connect(path: string): Promise<{ result: 'open' | 'error'; socket: WebSocket }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://${base}${path}`);
    socket.addEventListener('open', () => resolve({ result: 'open', socket }), { once: true });
    socket.addEventListener('error', () => resolve({ result: 'error', socket }), { once: true });
  });
}

// --- Protocolo de Hocuspocus, codificado a mano para no depender de @hocuspocus/provider ---
// Mensaje: varString(documento) · varUint(tipo) · contenido. Tipo 0 = Sync (y-protocols):
// varUint(subtipo: 0 step1, 1 step2, 2 update) · varUint8Array(datos).
const MESSAGE_SYNC = 0;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

function varUint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return bytes;
}

// Hocuspocus deja en cola todo hasta recibir el mensaje Auth (tipo 2, subtipo 0 = token),
// aunque no haya extensiones de autenticación; @hocuspocus/provider lo envía siempre primero.
const MESSAGE_AUTH = 2;
const AUTH_TOKEN = 0;

function authMessage(documentName: string, token: string): Uint8Array {
  const name = new TextEncoder().encode(documentName);
  const tokenBytes = new TextEncoder().encode(token);
  return Uint8Array.from([
    ...varUint(name.length), ...name, MESSAGE_AUTH, AUTH_TOKEN, ...varUint(tokenBytes.length), ...tokenBytes,
  ]);
}

function syncMessage(documentName: string, subtype: number, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(documentName);
  return Uint8Array.from([
    ...varUint(name.length), ...name, MESSAGE_SYNC, subtype, ...varUint(data.length), ...data,
  ]);
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  varUint(): number {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = this.bytes[this.offset++] ?? 0;
      value |= (byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
  }
  varUint8Array(): Uint8Array {
    const length = this.varUint();
    const data = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return data;
  }
  varString(): string {
    return new TextDecoder().decode(this.varUint8Array());
  }
}

/** Cliente mínimo: conecta, pide el estado (step1) y aplica a su Y.Doc todo lo que llega. */
async function syncClient(documentName: string): Promise<{ socket: WebSocket; doc: Y.Doc }> {
  const doc = new Y.Doc();
  const { result, socket } = await connect(COLLAB_PATH);
  expect(result).toBe('open');
  socket.binaryType = 'arraybuffer';
  let synced!: () => void;
  const ready = new Promise<void>((resolve) => (synced = resolve));
  socket.addEventListener('message', (event: MessageEvent) => {
    const reader = new Reader(new Uint8Array(event.data as ArrayBuffer));
    if (reader.varString() !== documentName || reader.varUint() !== MESSAGE_SYNC) return;
    const subtype = reader.varUint();
    if (subtype === SYNC_STEP2 || subtype === SYNC_UPDATE) {
      Y.applyUpdate(doc, reader.varUint8Array());
      if (subtype === SYNC_STEP2) synced();
    }
  });
  socket.send(authMessage(documentName, ''));
  socket.send(syncMessage(documentName, SYNC_STEP1, Y.encodeStateVector(doc)));
  await ready;
  return { socket, doc };
}

describe('apps/server: API REST y colaboración en el mismo puerto', () => {
  it('GET /health responde por HTTP', async () => {
    const response = await fetch(`http://${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it(`acepta WebSocket en ${COLLAB_PATH}`, async () => {
    const { result, socket } = await connect(COLLAB_PATH);
    expect(result).toBe('open');
    socket.close();
  });

  it(`acepta ${COLLAB_PATH} con query string (el proveedor de Hocuspocus puede agregar parámetros)`, async () => {
    const { result, socket } = await connect(`${COLLAB_PATH}?doc=abc`);
    expect(result).toBe('open');
    socket.close();
  });

  it.each(['/', '/health', '/collab/otro', '/collabx'])('rechaza el upgrade en %s', async (path) => {
    const { result } = await connect(path);
    expect(result).toBe('error');
  });

  it('sincroniza un documento Yjs entre dos clientes a través del servidor', async () => {
    const documentName = 'doc-de-prueba';
    const a = await syncClient(documentName);
    const b = await syncClient(documentName);

    // A escribe y envía el update; B lo tiene que recibir por el servidor.
    a.doc.getText('contenido').insert(0, 'hola desde A');
    a.socket.send(syncMessage(documentName, SYNC_UPDATE, Y.encodeStateAsUpdate(a.doc)));

    await expect.poll(() => b.doc.getText('contenido').toString(), { timeout: 3000 }).toBe('hola desde A');
    a.socket.close();
    b.socket.close();
  });

  it('al cerrar el servidor se cierran las conexiones de colaboración', async () => {
    const { socket } = await connect(COLLAB_PATH);
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (e) => resolve(e.code)));
    await app.close();
    expect(await closed).toBeGreaterThanOrEqual(1000);
    // afterEach vuelve a llamar a close(): Fastify lo tolera.
  });
});

/**
 * Manda una petición de upgrade cruda y devuelve la primera línea de la respuesta. `headers`
 * reemplaza o agrega cabeceras (valor `null` = omitir); por defecto, Host: x como antes.
 */
function rawUpgrade(target: string, headers: Record<string, string | null> = {}): Promise<string> {
  return new Promise((resolve) => {
    const [host, port] = base.split(':');
    const merged: Record<string, string | null> = {
      Host: 'x',
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
    const socket = connect_(Number(port), host ?? '127.0.0.1', () => {
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

describe('upgrade: Host y Origin', () => {
  it('Host evil.com → 403', async () => {
    expect(await rawUpgrade(COLLAB_PATH, { Host: 'evil.com' })).toBe('HTTP/1.1 403 Forbidden');
  });

  it('sin Host permitido pero con Origin válido → 403 (el Host manda)', async () => {
    expect(await rawUpgrade(COLLAB_PATH, { Host: 'evil.com', Origin: 'http://localhost:5173' })).toBe(
      'HTTP/1.1 403 Forbidden',
    );
  });

  it.each(['http://evil.com', 'null', 'http://localhost:5174'])('Origin %s → 403', async (origin) => {
    expect(await rawUpgrade(COLLAB_PATH, { Host: base, Origin: origin })).toBe('HTTP/1.1 403 Forbidden');
  });

  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])('Origin %s → 101', async (origin) => {
    expect(await rawUpgrade(COLLAB_PATH, { Host: base, Origin: origin })).toMatch(/^HTTP\/1\.1 101/);
  });

  it('sin Origin → 101', async () => {
    expect(await rawUpgrade(COLLAB_PATH, { Host: base })).toMatch(/^HTTP\/1\.1 101/);
  });

  it('el servidor sigue respondiendo tras los rechazos', async () => {
    await rawUpgrade(COLLAB_PATH, { Host: 'evil.com' });
    expect((await fetch(`http://${base}/health`)).status).toBe(200);
  });
});

describe('tamaño máximo de mensaje', () => {
  it(`un mensaje mayor que ${COLLAB_MAX_MESSAGE_BYTES} bytes cierra la conexión con 1009`, async () => {
    const { result, socket } = await connect(COLLAB_PATH);
    expect(result).toBe('open');
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (e) => resolve(e.code)));
    socket.send(new Uint8Array(COLLAB_MAX_MESSAGE_BYTES + 1));
    expect(await closed).toBe(1009);
  });

  it('un mensaje dentro del límite no cierra la conexión', async () => {
    const { result, socket } = await connect(COLLAB_PATH);
    expect(result).toBe('open');
    let closedCode: number | null = null;
    socket.addEventListener('close', (e) => (closedCode = e.code));
    socket.send(new Uint8Array(1024));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closedCode).toBeNull();
    socket.close();
  });
});

describe('upgrade con una URL que no se puede interpretar', () => {

  // Regresión: `new URL()` lanzaba fuera del try y la promesa rechazada sin manejar terminaba el
  // proceso (API y colaboración caídas con una sola petición).
  it.each(['//%', 'http://['])('%s → 400 y el servidor sigue respondiendo', async (target) => {
    expect(await rawUpgrade(target)).toBe('HTTP/1.1 400 Bad Request');
    const health = await fetch(`http://${base}/health`);
    expect(health.status).toBe(200);
  });
});
