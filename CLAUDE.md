# Overleaf Clone

Editor LaTeX web: proyectos con imágenes, compilación a PDF, colaboración en tiempo real y un editor
visual sobre el mismo documento. Plan y estado: `docs/roadmap.md`.

## Stack
- Monorepo pnpm workspaces, TypeScript estricto en todo
- `web/`: React + Vite, React Router, TanStack Query, Tailwind CSS, CodeMirror 6 + y-codemirror.next, PDF.js
- `server/`: Fastify (API REST bajo `/api`) + Hocuspocus (Yjs) en el mismo proceso, WebSocket en `/collab`;
  PostgreSQL con Drizzle ORM; sesiones con cookies httpOnly
- `compiler/`: worker BullMQ (Redis) que compila en Docker con TeX Live + latexmk
- Archivos binarios y resultados de compilación: MinIO (API S3). Server y compiler se comunican solo por
  Redis (cola) y MinIO
- `shared/`: contratos de la API (tipos y códigos de error) y utilidades puras comunes

- Documentación de la API: Swagger UI en `/api/docs` (OpenAPI en `/api/docs/json`), generada de los
  esquemas de cada ruta

## Comandos
- Instalar: `pnpm install`
- Toda la app en contenedores: `docker compose up -d --build`
  (el servicio compiler monta el socket de Docker: solo para uso local)
- Dev con hot reload: `docker compose up -d postgres redis minio` y después `pnpm dev` (lee `.env` si existe)
- Tests (con postgres, redis y minio levantados): `pnpm test`
- Tests de compilación real con Docker y TeX Live (lentos): `pnpm test:compile`
- Lint y tipos: `pnpm lint && pnpm typecheck`
- Base de datos: cambiar `server/src/schema.ts` y generar la migración con `pnpm db:generate`.
  El server aplica las migraciones pendientes al arrancar.

## Estructura de carpetas
Plana: una carpeta por app en la raíz (`server/`, `compiler/`, `web/`, `shared/`) y `docs/`. Una carpeta
nueva solo cuando agrupa varios archivos; si va a tener uno, es un archivo.

```
server/
  src/
    index.ts        arranque: config, migraciones, buildApp, listen, apagado
    app.ts          arma Fastify: cookies, multipart, guardas, errores y las rutas de cada feature bajo /api
    config.ts       único lugar donde se lee process.env
    db.ts           cliente de Drizzle y migrar
    schema.ts       todas las tablas
    http.ts         lo transversal de HTTP: ApiError y respuestas de error, guardas de Host y Origin
    openapi.ts      Swagger y los esquemas compartidos de las respuestas
    storage.ts      cliente S3 (MinIO)
    features/<f>/   routes.ts, service.ts y lo que la feature necesite
                    (auth, projects, files, sharing, collab, compile)
  drizzle/          migraciones SQL generadas
  test/             tests del server
compiler/
  texlive/          imagen de TeX Live de las compilaciones
  src/              index.ts, config.ts, processor.ts, docker.ts, workspace.ts, storage.ts, log.ts
  test/             tests del compiler; test/fixtures/ con los proyectos LaTeX de prueba
web/
  src/              main.tsx, app/ (router, providers, layout), lib/ (api.ts), components/ (UI genérica),
                    features/<f>/ (páginas, componentes y hooks de cada feature)
shared/src/         api/ (contratos por feature) y utilidades puras (project-paths, env)
```

- Las features se importan entre sí por sus archivos (`../auth/service`), sin `index.ts` de reexportación.
- Una feature no importa las rutas de otra; comparte lógica a través de su `service.ts`.
- Cada ruta declara su `schema` (tags, summary, params, body y response con los componentes de
  `openapi.ts`): es la documentación y la serialización. Un cuerpo multipart es solo documentación
  (`validatorCompiler: skipValidation`). No usar `enum` ni `required` en un cuerpo cuando el servicio
  ya responde un código de error más específico.

## Tests
- Van en `<app>/test/`, no al lado del código. `pnpm test` los corre todos menos los de compilación real.
- Uno por feature de punta a punta (`test/projects.test.ts`): HTTP con `app.inject` contra Postgres, Redis y
  MinIO reales. Cubre el camino feliz y los permisos.
- Unitarios solo para lógica pura no trivial o de seguridad (rutas, zip, matriz de permisos, parseo del log).
- Nada de tablas exhaustivas de casos triviales ni de un test por cada mensaje de error.
- Compilación real con Docker (`compiler/test/compile.test.ts`) solo con `pnpm test:compile`.

## Forma de trabajo
- Specs cortas en `docs/specs/`: objetivo, alcance, diseño, archivos, pasos, criterios y riesgos. Verificar
  los supuestos técnicos antes de escribirlos.
- Pocos pasos de alcance grande: cada uno entrega una parte completa y usable (rutas, lógica, persistencia y
  tests). Una spec tiene 3 o 4 pasos, no 10.
- Aprobada la spec, implementar de corrido con un commit por paso y reportar al final. Detenerse solo si un
  supuesto de la spec resulta falso o aparece una decisión de diseño que no está en la spec.
- Sin subagentes por paso. Una verificación en vivo al final de la spec, no en cada paso.
- Al cerrar una spec que toca sandbox, auth, permisos o archivos: `/security-review`. Crítico y alto se
  corrige en el momento; medio y bajo va a `docs/backlog.md`.
- Simplicidad antes que endurecimiento especulativo: proteger lo que está expuesto, no casos hipotéticos.

## Reglas
- Antes de una funcionalidad nueva, debe existir su spec en docs/specs/
- Al terminar cada paso: `pnpm test`, `pnpm typecheck` y `pnpm lint` en verde antes del commit
- Nunca habilitar shell-escape en la compilación de LaTeX
- Toda compilación corre sin red y con límites de CPU, RAM y tiempo
- Toda acción sobre un proyecto pasa por `assertProjectAccess`, también en el WebSocket
- No agregar dependencias sin explicar por qué
- Mensajes de commit en español, formato: `tipo: descripción`
