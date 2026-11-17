# Spec: estructura del monorepo

## 1. Objetivo
Crear el esqueleto del proyecto (monorepo pnpm, apps vacías, servicios de infraestructura y herramientas de
calidad) para que las funcionalidades futuras se desarrollen sobre una base común y verificable.

## 2. Alcance
**Incluye**
- pnpm workspaces con `apps/web`, `apps/server`, `apps/compiler` y `packages/shared`
- `tsconfig` estricto compartido y un punto de entrada mínimo por paquete
- `docker-compose.yml` con PostgreSQL, Redis y MinIO para desarrollo
- Vitest, ESLint (flat config) y los scripts `dev`, `test`, `lint` y `typecheck`

> **Cambio posterior:** la versión original tenía `apps/api` (Fastify) y `apps/collab` (Hocuspocus) como
> procesos separados. Se unieron en `apps/server` para simplificar la arquitectura: un solo proceso y un
> solo puerto. `apps/compiler` sigue separado como worker de la cola de Redis. Vitest pasó de un proyecto
> por paquete a uno solo, para poder excluir los tests de integración (ver `compilacion.md`, paso 5).

**No incluye**
- Modelos de datos ni Prisma, autenticación, editor, colaboración, compilación de LaTeX ni almacenamiento
- Dockerfiles de las apps, CI ni builds de producción

## 3. Diseño
| Paquete | Nombre | Punto de entrada |
|---|---|---|
| `packages/shared` | `@latexweb/shared` | Exporta tipos y constantes; se consume como código fuente TS (sin build) |
| `apps/server` | `@latexweb/server` | Fastify con `GET /health` → `{ ok: true }` y Hocuspocus sin extensiones montado en el mismo servidor HTTP (WebSocket en `/collab`). Puerto `SERVER_PORT`, 3000 |
| `apps/compiler` | `@latexweb/compiler` | Worker BullMQ en la cola `compile`; el processor responde "no implementado" |
| `apps/web` | `@latexweb/web` | Vite + React que muestra solo un título |

- TypeScript: `module: ESNext`, `moduleResolution: Bundler`. Las apps de Node se ejecutan con `tsx` en dev.
- Colaboración en `apps/server` (`src/features/collab/websocket.ts`): se usa `new Hocuspocus()` en lugar de su clase `Server`,
  para no crear un segundo servidor HTTP. El evento `upgrade` del servidor de Fastify pasa las conexiones
  a `/collab` al adaptador de Node de `crossws`, igual que hace internamente la clase `Server` de Hocuspocus
  4.8. Las demás rutas responden 404. `crossws` va como dependencia directa, fijada en la misma versión
  exacta que usa `@hocuspocus/server` (0.4.17). Las conexiones se cierran en el hook `preClose` de Fastify:
  en `onClose` es tarde, porque el servidor HTTP no termina de cerrarse mientras haya WebSockets abiertos.
  La autenticación de la conexión irá en el manejador de upgrade (spec de colaboración).
- Docker Compose: `postgres:17-alpine`, `redis:7-alpine` y `pgsty/minio` con un tag fijo. Puertos ligados a
  `127.0.0.1`, volúmenes con nombre, healthchecks y credenciales desde `.env`.

## 4. Archivos
Raíz: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`,
`docker-compose.yml`, `.env.example`, `.gitignore`, `.nvmrc`.
Cada paquete tiene `package.json`, `tsconfig.json` y `src/index.ts` (en web: `src/main.tsx`, `index.html` y
`vite.config.ts`).

## 5. Pasos
1. Archivos de la raíz
2. `packages/shared` y las apps, después `pnpm install`
3. `pnpm typecheck`, `pnpm lint` y `pnpm test`
4. `docker compose up -d` con los servicios en estado healthy

## 6. Criterios de aceptación
- [ ] `pnpm install` termina sin errores
- [ ] `pnpm typecheck`, `pnpm lint` y `pnpm test` salen con código 0
- [ ] `docker compose up -d` deja postgres, redis y minio en estado `healthy`
- [ ] `GET /health` de `apps/server` responde `{ "ok": true }`, y en el mismo puerto `/collab` acepta
      WebSocket y sincroniza un documento Yjs entre dos clientes (`apps/server/src/features/collab/websocket.test.ts`)

## 7. Riesgos
- MinIO dejó de publicar imágenes de la edición community: `minio/minio` ya no está en Docker Hub y quay.io
  exige autenticación. Usamos el fork comunitario `pgsty/minio`, fijado a un release, y dependemos de que lo
  sigan manteniendo.
- Puertos locales ocupados (p. ej. un Postgres instalado): se pueden cambiar con variables en `.env`.
- Las credenciales por defecto son solo para desarrollo, y los puertos quedan ligados a `127.0.0.1`.
