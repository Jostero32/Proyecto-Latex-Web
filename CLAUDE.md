# Overleaf Clone

Editor LaTeX web con compilación, vista PDF y colaboración en tiempo real.

## Stack
- Monorepo pnpm workspaces, TypeScript estricto en todo
- apps/web: React + Vite, CodeMirror 6, PDF.js
- apps/server: Fastify (API REST) + Hocuspocus (Yjs) en el mismo proceso, WebSocket en /collab; PostgreSQL con Prisma, sesiones con cookies httpOnly
- apps/compiler: worker BullMQ (Redis) que compila en Docker con TeX Live + latexmk
- Almacenamiento de archivos: MinIO (API S3)
- packages/shared: tipos compartidos

## Comandos
- Instalar: `pnpm install`
- Toda la app en contenedores (infraestructura, server, compiler y web): `docker compose up -d --build`
  (el servicio compiler monta el socket de Docker: solo para uso local)
- Dev con hot reload: `docker compose up -d postgres redis minio` y después `pnpm dev`
- Tests: `pnpm test`
- Tests de integración (Docker real): `pnpm test:integration`
- Lint y tipos: `pnpm lint && pnpm typecheck`

## Estructura de carpetas
Todo código nuevo sigue estas reglas.

apps/server/src:
- `index.ts`: solo arranque (config, `buildApp`, listen, apagado)
- `app.ts`: `buildApp`, que arma la instancia de Fastify y registra plugins y funcionalidades
- `config.ts`: configuración; único lugar donde se lee `process.env`
- `plugins/`: plugins de Fastify compartidos entre funcionalidades (p. ej. multipart)
- `lib/`: utilidades sin lógica de negocio (no importan de `features/`)
- `features/<funcionalidad>/`: todo lo de una funcionalidad. Los archivos se nombran por su rol, sin
  repetir el nombre de la carpeta (`features/compilations/routes.ts`, `storage.ts`, `upload.ts`).
  `index.ts` es su API pública: desde fuera de la carpeta se importa solo `index.ts`, nunca un
  archivo interno de otra funcionalidad.

apps/compiler/src:
- `index.ts` (arranque) y `config.ts` (único lugar donde se lee `process.env`)
- `worker/`: processor de la cola
- `docker/`: argumentos de `docker run` y ejecución del contenedor
- `workspace/`: directorios de trabajo en disco

Tests:
- Unitarios: al lado de su archivo, como `<archivo>.test.ts`. Corren con `pnpm test`.
- De integración: en `apps/<app>/test/integration/`. Son los que necesitan servicios externos
  (Docker, Redis, Postgres, MinIO) o son lentos. Corren con `pnpm test:integration`.
- No crear carpetas vacías: `plugins/`, `lib/` y cada `features/<funcionalidad>/` aparecen con su primer archivo.

## Reglas
- Antes de una funcionalidad nueva, debe existir su spec en docs/specs/
- Pasos pequeños: implementar, correr tests, luego seguir
- Nunca habilitar shell-escape en la compilación de LaTeX
- Toda compilación corre sin red y con límites de CPU, RAM y tiempo
- No agregar dependencias sin explicar por qué
- Mensajes de commit en español, formato: `tipo: descripción`
