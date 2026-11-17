# Overleaf Clone

Editor LaTeX web: proyectos con imágenes, compilación a PDF, colaboración en tiempo real y un editor
visual sobre el mismo documento. Plan y estado: `docs/roadmap.md`.

## Stack
- Monorepo pnpm workspaces, TypeScript estricto en todo
- apps/web: React + Vite, React Router, TanStack Query, Tailwind CSS, CodeMirror 6 + y-codemirror.next, PDF.js
- apps/server: Fastify (API REST bajo `/api`) + Hocuspocus (Yjs) en el mismo proceso, WebSocket en `/collab`;
  PostgreSQL con Drizzle ORM; sesiones con cookies httpOnly
- apps/compiler: worker BullMQ (Redis) que compila en Docker con TeX Live + latexmk
- Archivos: MinIO (API S3). Server y compiler se comunican solo por Redis (cola) y MinIO (archivos)
- packages/shared: contratos de la API (tipos de request/response y códigos de error) y utilidades comunes

El navegador ve un solo origen: Vite (dev y preview) hace de proxy de `/api` y `/collab` al server.

> Bloque 1 del roadmap en curso: el código todavía usa Prisma (pasa a Drizzle), rutas sin `/api` y disco
> compartido entre server y compiler (pasa a MinIO en el bloque 2).

## Comandos
- Instalar: `pnpm install`
- Toda la app en contenedores: `docker compose up -d --build` → http://localhost:5173
  (el servicio compiler monta el socket de Docker: solo para uso local)
- Dev con hot reload: `docker compose up -d postgres redis minio` y después `pnpm dev` (lee `.env` si existe)
- Tests: `pnpm test` · integración (Docker, Postgres, Redis, MinIO reales): `pnpm test:integration`
- Lint y tipos: `pnpm lint && pnpm typecheck`
- Base de datos: cambiar `apps/server/src/db/schema.ts` y generar la migración con
  `pnpm --filter @latexweb/server db:generate`. El server aplica las migraciones pendientes al arrancar.

## Estructura de carpetas
Todo código nuevo sigue estas reglas. No crear carpetas vacías: cada una aparece con su primer archivo.

**Regla común a server y web:** el código de una funcionalidad vive en `features/<funcionalidad>/`, con
archivos nombrados por su rol sin repetir el nombre de la carpeta (`features/projects/routes.ts`, no
`projects-routes.ts`). `index.ts` es su API pública: desde fuera se importa solo `index.ts`, nunca un
archivo interno de otra funcionalidad.

apps/server/src:
- `index.ts`: solo arranque (config, migraciones, `buildApp`, listen, apagado)
- `app.ts`: `buildApp`, que arma Fastify y registra plugins y funcionalidades bajo `/api`
- `config.ts`: configuración; único lugar donde se lee `process.env`
- `db/`: `schema.ts` (todas las tablas), `client.ts` y `migrate.ts`. Migraciones SQL en `apps/server/drizzle/`
- `plugins/`: plugins de Fastify compartidos (multipart, cookies, guardas de request)
- `lib/`: utilidades sin lógica de negocio (no importan de `features/` ni de `db/`), p. ej. el cliente S3
- `features/<funcionalidad>/`: `routes.ts`, `service.ts` (lógica y acceso a datos) y lo que haga falta

apps/web/src:
- `main.tsx` y `app/`: router, providers (TanStack Query) y layout
- `lib/`: cliente HTTP de la API (`api.ts`), utilidades sin UI
- `components/`: componentes de UI genéricos y sin lógica de negocio (botón, diálogo, panel)
- `features/<funcionalidad>/`: páginas, componentes, hooks y llamadas a la API de esa funcionalidad
  (`auth`, `projects`, `files`, `editor`, `pdf`, `collab`…)

apps/compiler:
- `texlive/`: Dockerfile e imagen de TeX Live de las compilaciones
- `src/index.ts` (arranque) y `src/config.ts` (único lugar donde se lee `process.env`)
- `src/worker/` (processor), `src/docker/` (`docker run` y ejecución), `src/workspace/` (disco de trabajo
  propio del compiler) y `src/storage/` (bajar entradas y subir resultados a MinIO)

packages/shared/src: `api/` (contratos por funcionalidad) y utilidades puras (`project-paths`, `env`).

Tests:
- Unitarios: al lado de su archivo, como `<archivo>.test.ts`. Corren con `pnpm test`.
- De integración: en `apps/<app>/test/integration/`. Los que necesitan servicios externos o son lentos.

## Forma de trabajo
- Prioridad: que cada bloque termine en algo usable en el navegador. Backend sin pantalla no cierra un bloque.
- Specs cortas en `docs/specs/` (~1 página): objetivo, alcance, diseño, archivos, pasos, criterios y riesgos.
  Verificar los supuestos técnicos antes de escribirlos.
- Pasos de alcance grande: cada uno entrega una parte completa y usable (UI, rutas, lógica, persistencia y
  tests). Preferir pocos pasos.
- Aprobada la spec, implementar de corrido con un commit por paso y reportar al final. Detenerse solo si un
  supuesto de la spec resulta falso o aparece una decisión de diseño que no está en la spec.
- Tests escritos junto con el código, pocos y útiles:
  - unitarios para lógica no trivial y para todo lo de seguridad; nada de tablas exhaustivas de casos triviales;
  - un test de punta a punta por funcionalidad;
  - `pnpm test:integration` solo si cambia algo de compilación, Docker o base de datos.
- Una verificación en vivo en el navegador al final de cada bloque, no en cada paso.
- Al cerrar un bloque que toca sandbox, auth, permisos o archivos: `/security-review`. Crítico y alto se
  corrige en el momento; medio y bajo va a `docs/backlog.md`.
- Simplicidad antes que endurecimiento especulativo: proteger lo que está expuesto, no casos hipotéticos.

## Reglas
- Antes de una funcionalidad nueva, debe existir su spec en docs/specs/
- Al terminar cada paso: `pnpm test`, `pnpm typecheck` y `pnpm lint` en verde antes del commit
- Nunca habilitar shell-escape en la compilación de LaTeX
- Toda compilación corre sin red y con límites de CPU, RAM y tiempo
- Autorización de proyectos siempre con `assertProjectAccess`, también en el WebSocket
- No agregar dependencias sin explicar por qué
- Mensajes de commit en español, formato: `tipo: descripción`
