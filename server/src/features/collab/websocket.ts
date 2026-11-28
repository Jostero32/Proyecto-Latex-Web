// Colaboración en tiempo real: Hocuspocus (Yjs) montado sobre el servidor HTTP de Fastify,
// en el mismo proceso y puerto que la API REST. WebSocket en COLLAB_PATH.
//
// Replica la unión que hace la clase `Server` de @hocuspocus/server 4.8 (adaptador de Node de
// crossws → hocuspocus.handleConnection) pero sin crear un segundo servidor HTTP.
//
// Seguridad, en orden: Host y Origin (como la API), la cookie de sesión antes de aceptar el upgrade,
// y en `onConnect` el permiso sobre el proyecto del documento (`project:<id>`): un lector queda en
// solo lectura. Un documento no puede crecer más de `docMaxBytes`.
import { hasAcceptedPrivacy } from '@latexweb/shared';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hocuspocus, type Document, type WebSocketLike } from '@hocuspocus/server';
import crossws from 'crossws/adapters/node';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import type { Db } from '../../db';
import { isAllowedHost, isAllowedOrigin, type RequestGuardOptions } from '../../http';
import { SESSION_COOKIE } from '../auth/guard';
import type { AuthService } from '../auth/service';
import { assertProjectAccess, roleAllows } from '../projects/service';
import { loadDocument, projectIdOf, storeDocument, type CollabContext } from './documents';

export const COLLAB_PATH = '/collab';

/**
 * Tamaño máximo de un mensaje WebSocket. El valor por defecto de `ws` es 100 MiB, y se aplica
 * antes de autenticar: muchas conexiones con mensajes así agotarían la memoria del proceso, que
 * también sirve la API.
 */
export const COLLAB_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Código de cierre de la conexión a un documento que supera el tope. */
export const DOC_TOO_LARGE_CODE = 4413;

type ClientConnection = ReturnType<Hocuspocus['handleConnection']>;

export interface CollabOptions {
  /** Sin base: documentos en memoria y sin permisos (solo para los tests del upgrade). */
  db?: Db;
  auth?: AuthService;
  docMaxBytes: number;
}

/** Hocuspocus con persistencia en `documents`, permisos por proyecto y tope de tamaño. */
export function createCollab({ db, auth, docMaxBytes }: CollabOptions): Hocuspocus {
  // Tamaño estimado de cada documento abierto: el exacto (codificar el documento) se calcula solo
  // cuando la suma de lo recibido se acerca al tope.
  const estimates = new WeakMap<Document, number>();
  const sizeOf = (document: Document) => Y.encodeStateAsUpdate(document).length;

  return new Hocuspocus<CollabContext>({
    name: 'collab',
    quiet: true,
    debounce: 2_000,
    maxDebounce: 10_000,
    ...(db
      ? {
          async onLoadDocument({ document, documentName }) {
            const projectId = projectIdOf(documentName);
            if (!projectId) throw new Error(`documento inválido: ${documentName}`);
            await loadDocument(db, projectId, document);
          },
          async onStoreDocument({ document, documentName }) {
            const projectId = projectIdOf(documentName);
            if (projectId) await storeDocument(db, projectId, document);
          },
          // Antes de cargar el documento: un no miembro (o un nombre que no es de proyecto) no llega a
          // abrirlo. Hocuspocus responde permission-denied a ese documento.
          async onConnect({ documentName, context, connectionConfig }) {
            const projectId = projectIdOf(documentName);
            if (!projectId || !context.userId) throw new Error('documento o sesión inválidos');
            const { role } = await assertProjectAccess(db, context.userId, projectId, 'read');
            connectionConfig.readOnly = !roleAllows(role, 'write');
          },
        }
      : {}),
    async beforeHandleMessage({ document, documentName, update, context, connection }) {
      if (auth) {
        const user = context.sessionToken ? await auth.getUserBySessionToken(context.sessionToken) : null;
        if (!user || user.id !== context.userId || !hasAcceptedPrivacy(user)) {
          throw Object.assign(new Error('sesión inválida'), { code: 4401, reason: 'session-expired' });
        }
      }
      if (db) {
        const projectId = projectIdOf(documentName);
        if (!projectId || !context.userId) throw new Error('documento o sesión inválidos');
        try {
          const { role } = await assertProjectAccess(db, context.userId, projectId, 'read');
          // También detecta cambios desde otra instancia o directamente en BD, sin reconexión.
          connection.readOnly = !roleAllows(role, 'write');
        } catch {
          throw Object.assign(new Error('permisos revocados'), { code: 4403, reason: 'permissions-changed' });
        }
      }
      let estimate = (estimates.get(document) ?? sizeOf(document)) + update.length;
      if (estimate > docMaxBytes) estimate = sizeOf(document) + update.length;
      estimates.set(document, estimate);
      if (estimate > docMaxBytes) {
        throw Object.assign(new Error('documento demasiado grande'), { code: DOC_TOO_LARGE_CODE, reason: 'document-too-large' });
      }
    },
  });
}

export interface AttachCollabOptions {
  guard: RequestGuardOptions;
  /** Sin auth se rechaza toda conexión (401). */
  auth?: AuthService;
}

/** Monta Hocuspocus en `app`. Requiere @fastify/cookie registrado. */
export function attachCollab(app: FastifyInstance, hocuspocus: Hocuspocus, { guard, auth }: AttachCollabOptions): void {
  const connections = new WeakMap<object, ClientConnection>();

  const websocket = crossws({
    serverOptions: { maxPayload: COLLAB_MAX_MESSAGE_BYTES },
    hooks: {
      // La sesión se valida antes de aceptar el upgrade; el usuario queda en el contexto del peer.
      async upgrade(request) {
        const token = app.parseCookie(request.headers.get('cookie') ?? '')[SESSION_COOKIE];
        const user = auth && token ? await auth.getUserBySessionToken(token) : null;
        if (!user) return new Response(null, { status: 401, statusText: 'Unauthorized' });
        if (!hasAcceptedPrivacy(user)) return new Response(null, { status: 403, statusText: 'Privacy acceptance required' });
        return { context: { userId: user.id, sessionToken: token } };
      },
      open(peer) {
        const context: CollabContext = { userId: String(peer.context.userId), sessionToken: String(peer.context.sessionToken) };
        const connection = hocuspocus.handleConnection(asWebSocketLike(peer.websocket), peer.request, context);
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
    // Nunca dejar una promesa rechazada sin manejar: en Node 22 eso termina el proceso, y con él
    // la API y la colaboración.
    handleUpgrade(request, socket, head).catch((error: unknown) => {
      app.log.error({ err: error }, 'error inesperado en el upgrade de WebSocket');
      rejectUpgrade(socket, 500, 'Internal Server Error');
    });
  });

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = parsePath(request.url);
    if (path === null) {
      // p. ej. `GET //% HTTP/1.1`: el parser de URL lanza y antes tumbaba el proceso.
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (path !== COLLAB_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    // El navegador deja que cualquier página abra un WebSocket a 127.0.0.1 (no hay CORS): sin
    // esto, otro sitio que el usuario visite podría usar su cookie para leer y escribir documentos.
    // Host contra DNS rebinding; Origin contra sitios ajenos (sin Origin = no es un navegador).
    if (!isAllowedHost(request.headers.host, guard)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    // Como en la API: también se acepta el mismo origen que el Host (la web servida por el mismo host).
    if (!isAllowedOrigin(origin, guard, request.headers.host)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    await websocket.handleUpgrade(request, socket, head);
  }

  // preClose y no onClose: onClose corre después de que el servidor HTTP terminó de cerrarse, y
  // eso no ocurre mientras haya WebSockets abiertos (app.close() quedaría colgado). Antes de cerrar,
  // se guardan los documentos con cambios pendientes (el debounce).
  app.addHook('preClose', async () => {
    hocuspocus.closeConnections();
    websocket.closeAll(1001, 'servidor cerrándose');
    hocuspocus.flushPendingStores();
    await waitForUnload(hocuspocus);
  });
}

/** Espera a que los documentos abiertos se guarden y se descarguen (hasta 5 s). */
async function waitForUnload(hocuspocus: Hocuspocus): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (hocuspocus.documents.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
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

/** Ruta de la petición, o null si la URL no se puede interpretar. */
function parsePath(url: string | undefined): string | null {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.writable) socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
