// Colaboración en tiempo real: Hocuspocus (Yjs) montado sobre el servidor HTTP de Fastify,
// en el mismo proceso y puerto que la API REST. WebSocket en COLLAB_PATH.
//
// Replica la unión que hace la clase `Server` de @hocuspocus/server 4.8 (adaptador de Node de
// crossws → hocuspocus.handleConnection) pero sin crear un segundo servidor HTTP.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hocuspocus, type WebSocketLike } from '@hocuspocus/server';
import crossws from 'crossws/adapters/node';
import type { FastifyInstance } from 'fastify';

export const COLLAB_PATH = '/collab';

type ClientConnection = ReturnType<Hocuspocus['handleConnection']>;

/** Monta Hocuspocus en `app` (sin extensiones: ni autenticación ni persistencia todavía). */
export function attachCollab(app: FastifyInstance): Hocuspocus {
  const hocuspocus = new Hocuspocus({ name: 'collab', quiet: true });
  const connections = new WeakMap<object, ClientConnection>();

  const websocket = crossws({
    hooks: {
      open(peer) {
        const connection = hocuspocus.handleConnection(asWebSocketLike(peer.websocket), peer.request);
        connections.set(peer, connection);
        // Hocuspocus cierra las conexiones inactivas; un pong cuenta como actividad.
        (peer.websocket as { on?: (event: string, listener: () => void) => void }).on?.('pong', () =>
          connection.touch(),
        );
      },
      message(peer, message) {
        connections.get(peer)?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        connections.get(peer)?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? '' });
        connections.delete(peer);
      },
      error(peer, error) {
        app.log.error({ err: error, peer: peer.id }, 'error de WebSocket en collab');
      },
    },
  });

  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(request, socket, head);
  });

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== COLLAB_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    // AUTENTICACIÓN (pendiente, spec de colaboración): validar aquí la sesión (cookie httpOnly)
    // y el permiso sobre el documento ANTES de aceptar el upgrade, y rechazar con 401/403 con
    // rejectUpgrade. Hoy cualquier cliente que llegue al puerto puede conectarse.
    try {
      // Mismo hook que dispara la clase Server de Hocuspocus antes del upgrade (extensiones).
      await hocuspocus.hooks('onUpgrade', { request, socket, head, instance: hocuspocus });
      await websocket.handleUpgrade(request, socket, head);
    } catch (error) {
      app.log.warn({ err: error }, 'upgrade de WebSocket rechazado en collab');
      rejectUpgrade(socket, 400, 'Bad Request');
    }
  }

  // preClose y no onClose: onClose corre después de que el servidor HTTP terminó de cerrarse, y
  // eso no ocurre mientras haya WebSockets abiertos (app.close() quedaría colgado).
  app.addHook('preClose', async () => {
    hocuspocus.closeConnections();
    websocket.closeAll(1001, 'servidor cerrándose');
  });

  return hocuspocus;
}

/** crossws tipa el socket como Partial<WebSocket> (su propio tipo); Hocuspocus necesita send, close y readyState. */
function asWebSocketLike(socket: object): WebSocketLike {
  if (!isWebSocketLike(socket)) throw new Error('el WebSocket de crossws no tiene la forma que espera Hocuspocus');
  return socket;
}

function isWebSocketLike(socket: object): socket is WebSocketLike {
  const candidate = socket as Partial<Record<'send' | 'close' | 'readyState', unknown>>;
  return (
    typeof candidate.send === 'function' &&
    typeof candidate.close === 'function' &&
    typeof candidate.readyState === 'number'
  );
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.writable) socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
