# Spec: cimientos (bloque 1)

## 1. Objetivo
Dejar la base sobre la que se construye el producto: base de datos con Drizzle en lugar de Prisma, un
solo origen para el navegador y una web real con registro, login y logout. Al terminar se entra a
http://localhost:5173, se crea una cuenta y se ve una página de inicio protegida.

## 2. Alcance
**Incluye**
- Drizzle ORM con las mismas tablas de auth; migraciones aplicadas al arrancar el server.
- Rutas de la API bajo `/api` (`/api/auth/*`, `/api/compilations/*`, `/api/health`) y proxy de Vite
  (dev y preview) para `/api` y `/collab`.
- Web: React Router, TanStack Query, Tailwind CSS, cliente de la API, páginas de registro y login, y una
  página de inicio protegida con el usuario y "Cerrar sesión".
- Contratos de auth en `packages/shared/src/api/auth.ts` (usuario público, cuerpos y códigos de error).
- `apps/compiler/docker/` → `apps/compiler/texlive/`; `.env` opcional en `pnpm dev`; CI en GitHub Actions.

**No incluye**: proyectos, cambios en la compilación (bloque 2), recuperación de contraseña ni OAuth.

## 3. Diseño
**Base de datos**
- `apps/server/src/db/schema.ts` con `users` (`id` uuid, `email` único, `name?`, `password_hash`,
  `created_at`) y `sessions` (`id` = sha256 del token, `user_id` con cascada, `created_at`, `expires_at`,
  índices en `user_id` y `expires_at`). Misma semántica que hoy; nombres en snake_case.
- `db/client.ts`: `drizzle(pool)` con `pg`. `db/migrate.ts`: `migrate(db, { migrationsFolder })` de
  `drizzle-orm/node-postgres/migrator`, llamado en `index.ts` antes de `listen`.
- `drizzle.config.ts` (solo para la CLI `drizzle-kit generate`); la URL se toma de `config.ts`.
- Se borran `prisma/`, `prisma.config.ts`, `src/generated`, el `postinstall`, los `allowBuilds` de Prisma,
  el servicio `migrate` de compose y la etapa `server-build` y `migrate` del Dockerfile. La imagen del
  server copia `apps/server/drizzle/`.
- Las bases locales existentes se descartan (`docker compose down -v` o borrar el volumen de postgres): no
  hay datos de producción.

**Un solo origen**
- `buildApp` registra todo bajo el prefijo `/api`; `/collab` queda igual.
- `vite.config.ts`: `server.proxy` y `preview.proxy` con `/api` → server y `/collab` → server (`ws: true`),
  sin `changeOrigin`, para que Host y Origin sigan siendo los del navegador y pasen el request-guard.
  El destino sale de `LATEXWEB_SERVER_URL` (por defecto `http://127.0.0.1:3000`; en compose
  `http://server:3000`).

**Web** (`apps/web/src`)
- `app/router.tsx`: `/login`, `/registro` y `/` (protegida: sin sesión redirige a `/login`).
- `lib/api.ts`: `fetch` con `credentials: 'same-origin'`; convierte `{ error, message }` en un `ApiError`
  tipado con los códigos de `@latexweb/shared`.
- `features/auth/`: `useMe()` (query de `/api/auth/me`), `useLogin`, `useRegister` y `useLogout`
  (mutaciones que actualizan la query), y `LoginPage` y `RegisterPage` con los errores del servidor en el
  formulario (email tomado, contraseña débil, credenciales inválidas, 429).
- `components/`: los primeros componentes genéricos (botón, campo de texto, tarjeta) con Tailwind.

**Dependencias nuevas**
- server: `drizzle-orm` (ORM sin generación de código ni binarios) y `drizzle-kit` (dev, genera las
  migraciones SQL). Se quitan `@prisma/client`, `@prisma/adapter-pg` y `prisma`. `pg` se queda.
- web: `react-router` (rutas), `@tanstack/react-query` (estado del servidor, caché y reintentos sin
  código propio), `tailwindcss` y `@tailwindcss/vite` (estilos sin mantener CSS a mano).

**DX**: los scripts `dev` de server y compiler corren `tsx --env-file-if-exists=../../.env` (Node ≥ 22.9).
CI (`.github/workflows/ci.yml`): `pnpm install --frozen-lockfile`, `lint`, `typecheck` y `test`.

## 4. Archivos
- `apps/server/`: `src/db/{schema,client,migrate}.ts`, `drizzle.config.ts`, `drizzle/` (generado),
  `src/features/auth/service.ts` (consultas con Drizzle), `src/app.ts`, `src/index.ts`, `src/config.ts`,
  `package.json`; se borran `prisma/`, `prisma.config.ts` y `src/lib/db.ts`
- `apps/web/`: `vite.config.ts`, `src/main.tsx`, `src/app/*`, `src/lib/api.ts`, `src/features/auth/*`,
  `src/components/*`, `src/index.css`
- `packages/shared/src/api/auth.ts`
- `apps/compiler/texlive/` (movido), `Dockerfile`, `docker-compose.yml`, `pnpm-workspace.yaml`,
  `.env.example`, `.github/workflows/ci.yml`, `docs/specs/auth.md` (nota del cambio)

## 5. Pasos
1. **Drizzle y `/api`:** esquema, migración inicial, migrar al arrancar, `AuthService` con Drizzle, prefijo
   `/api`, limpieza de Prisma en compose y en el Dockerfile. Tests de integración de auth en verde.
2. **Web con auth:** router, query client, Tailwind, `api.ts`, contratos compartidos, páginas de registro,
   login e inicio, y proxy de Vite. Test unitario de `api.ts` (errores tipados).
3. **Orden y CI:** mover `texlive/`, `.env` en dev, workflow de CI, actualizar docs.

Al final: verificación en vivo con `docker compose up -d --build` y en dev con `pnpm dev`.

## 6. Criterios de aceptación
- [ ] `docker compose up -d --build` en una base vacía crea las tablas solo, sin servicio `migrate`.
- [ ] En http://localhost:5173: registrarse deja la sesión iniciada; recargar mantiene la sesión; cerrar
      sesión vuelve a `/login`; `/` sin sesión redirige a `/login`; los errores se ven en el formulario.
- [ ] Lo mismo con `pnpm dev`, con hot reload en web y server.
- [ ] No queda ninguna referencia a Prisma en el repo (fuera de `docs/specs` históricas).
- [ ] `pnpm test`, `typecheck`, `lint` y `test:integration` pasan; el workflow de CI pasa.

## 7. Riesgos
- **Migraciones con varias réplicas del server:** el migrador de Drizzle no toma un lock. Hoy hay una sola
  réplica; en despliegue, migrar en un paso previo.
- **Proxy y request-guard:** si el proxy reescribiera Host u Origin, el guard rechazaría todo. Por eso va
  sin `changeOrigin`, y se verifica en vivo también para el WebSocket.
- **`pnpm dev` sin `.env`:** `--env-file-if-exists` no falla si no existe y los valores por defecto siguen
  funcionando.
