// Documentación de la API (OpenAPI 3.1) a partir de los esquemas de cada ruta: el JSON en
// /api/docs/json y Swagger UI en /api/docs. Los esquemas de respuesta también los usa Fastify para
// serializar (más rápido y sin filtrar campos de más); los de cuerpo, para validar tipos.
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance, FastifySchema } from 'fastify';
import { ASSIGNABLE_ROLES, ENGINES, FILE_KINDS, PROJECT_ROLES } from '@latexweb/shared';

export const DOCS_PATH = '/api/docs';

const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: [schema.type as string, 'null'] });
const dateTime = { type: 'string', format: 'date-time' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;

/** Esquemas con nombre: aparecen como componentes del documento y se usan con `ref('Nombre')`. */
const COMPONENTS = {
  Error: {
    type: 'object',
    description: 'Todos los errores de la API tienen esta forma.',
    properties: { error: { type: 'string', description: 'Código estable para el programa' }, message: { type: 'string' } },
    required: ['error', 'message'],
  },
  User: {
    type: 'object',
    properties: { id: uuid, email: { type: 'string' }, name: nullable({ type: 'string' }), createdAt: dateTime },
    required: ['id', 'email', 'name', 'createdAt'],
  },
  Project: {
    type: 'object',
    properties: {
      id: uuid,
      name: { type: 'string' },
      mainFile: { type: 'string' },
      engine: { type: 'string', enum: [...ENGINES] },
      role: { type: 'string', enum: [...PROJECT_ROLES], description: 'Mi rol en el proyecto' },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
    required: ['id', 'name', 'mainFile', 'engine', 'role', 'createdAt', 'updatedAt'],
  },
  ProjectFile: {
    type: 'object',
    properties: {
      id: uuid,
      path: { type: 'string', examples: ['figuras/logo.png'] },
      kind: { type: 'string', enum: [...FILE_KINDS], description: 'text: se edita en vivo; binary: imagen u otro' },
      size: { type: 'integer' },
      updatedAt: dateTime,
    },
    required: ['id', 'path', 'kind', 'size', 'updatedAt'],
  },
  Member: {
    type: 'object',
    properties: {
      userId: uuid,
      email: { type: 'string' },
      name: nullable({ type: 'string' }),
      role: { type: 'string', enum: [...PROJECT_ROLES] },
    },
    required: ['userId', 'email', 'name', 'role'],
  },
  ShareLink: {
    type: 'object',
    properties: {
      recipientEmail: { type: ['string', 'null'] },
      id: uuid,
      role: { type: 'string', enum: [...ASSIGNABLE_ROLES] },
      createdAt: dateTime,
      expiresAt: nullable({ type: 'string', format: 'date-time' }),
      token: { type: 'string', description: 'Solo en la respuesta de creación' },
    },
    required: ['id', 'role', 'createdAt', 'expiresAt'],
  },
  Diagnostic: {
    type: 'object',
    properties: {
      file: nullable({ type: 'string' }),
      line: nullable({ type: 'integer' }),
      level: { type: 'string', enum: ['error', 'warning', 'info'] },
      message: { type: 'string' },
    },
    required: ['file', 'line', 'level', 'message'],
  },
  Compilation: {
    type: 'object',
    properties: {
      id: uuid,
      projectId: uuid,
      status: { type: 'string', enum: ['queued', 'running', 'success', 'error', 'timeout', 'failed'] },
      engine: { type: 'string', enum: [...ENGINES] },
      mainFile: { type: 'string' },
      createdAt: dateTime,
      finishedAt: dateTime,
      expiresAt: dateTime,
      durationMs: { type: 'integer' },
      exitCode: nullable({ type: 'integer' }),
      pdfMissingReason: { type: ['string', 'null'], enum: ['not_produced', 'too_large', null] },
      diagnostics: { type: 'array', items: { $ref: 'Diagnostic#' } },
      pdfUrl: { type: 'string' },
      logUrl: { type: 'string' },
      synctexUrl: { type: 'string' },
    },
    required: ['id', 'projectId', 'status', 'engine', 'mainFile', 'createdAt'],
  },
} as const;

export type ComponentName = keyof typeof COMPONENTS;

export const ref = (name: ComponentName) => ({ $ref: `${name}#` });

/** `{ clave: Componente }` como objeto de respuesta. */
export const wrap = (key: string, name: ComponentName) => ({
  type: 'object',
  properties: { [key]: ref(name) },
  required: [key],
});
export const wrapList = (key: string, name: ComponentName) => ({
  type: 'object',
  properties: { [key]: { type: 'array', items: ref(name) } },
  required: [key],
});

export const idParams = (...names: string[]) => ({
  type: 'object',
  properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])),
  required: names,
});

/** Errores 4xx y 5xx con la forma común. */
export const errors = { '4xx': ref('Error'), '5xx': ref('Error') };

/** Respuesta sin cuerpo (204). */
export const empty = { type: 'null', description: 'Sin contenido' };

/** Respuesta binaria o de texto (no JSON); solo documenta, no serializa. */
export const binary = (description: string) => ({ description, type: 'string', format: 'binary' });

/**
 * Cuerpo multipart: solo para la documentación. Fastify no lo valida (el multipart se lee en la ruta),
 * así que las rutas que lo usan llevan `validatorCompiler: skipValidation`.
 */
export const multipart = (properties: Record<string, unknown>, description: string): FastifySchema => ({
  consumes: ['multipart/form-data'],
  body: { type: 'object', description, properties },
});
export const skipValidation = () => () => true;

/** Registra los esquemas compartidos y, si `docs`, OpenAPI y Swagger UI. Antes de las rutas. */
export async function registerOpenApi(app: FastifyInstance, docs: boolean): Promise<void> {
  for (const [name, schema] of Object.entries(COMPONENTS)) app.addSchema({ $id: name, ...schema });
  if (!docs) return;
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'latexweb API',
        version: '1.0.0',
        description:
          'API del editor LaTeX colaborativo. La sesión es una cookie httpOnly (`sid`) que dan registro e inicio de ' +
          'sesión. Las peticiones que modifican estado desde un navegador tienen que traer un Origin permitido. ' +
          'La edición en vivo va por WebSocket en `/collab` (Hocuspocus/Yjs, documento `project:<id>`).',
      },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'sid' } } },
      security: [{ session: [] }],
      tags: [
        { name: 'auth', description: 'Registro, sesión y usuario actual' },
        { name: 'projects', description: 'Proyectos, importar y exportar zip' },
        { name: 'files', description: 'Árbol de archivos, texto e imágenes' },
        { name: 'sharing', description: 'Miembros y enlaces para compartir (solo el dueño)' },
        { name: 'compile', description: 'Compilar, estado, diagnósticos, PDF, log y SyncTeX' },
      ],
    },
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, i) => String(json.$id ?? `def-${i}`) },
  });
  await app.register(swaggerUi, {
    routePrefix: DOCS_PATH,
    staticCSP: true,
    transformStaticCSP: () => [
      "default-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "object-src 'none'",
      "connect-src 'self'", "img-src 'self' data:", "font-src 'self'", "form-action 'self'",
      `script-src 'self' ${app.swaggerCSP.script.join(' ')}`,
      `style-src 'self' ${app.swaggerCSP.style.join(' ')}`,
    ].join('; '),
  });
}
