# Spec: auth

## 1. Objetivo
Cuentas de usuario con registro, login y logout, y sesiones en cookies httpOnly. Monta la base de datos
(Prisma + Postgres) para todo el proyecto. Es la base de `proyectos-y-archivos`, permisos y colaboración.

## 2. Alcance
**Incluye**
- Prisma 7 + Postgres: schema, migraciones, cliente generado y migración automática en docker compose.
- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout` y `GET /auth/me`.
- Contraseñas con argon2id, sesiones guardadas en Postgres, protección CSRF y rate limit en login y registro.
- `requireUser`, un preHandler para que otras funcionalidades exijan sesión.

**No incluye** (backlog): verificación de email, recuperación de contraseña, OAuth, 2FA, "cerrar todas
las sesiones", borrar la cuenta, y exigir sesión en `/compilations` y `/collab` (eso es de
`compilar-proyecto` y `colaboracion`).

## 3. Diseño
**Modelo**

| Modelo | Campos |
|---|---|
| `User` | `id` (uuid), `email` (único, en minúsculas y sin espacios), `name?`, `passwordHash`, `createdAt` |
| `Session` | `id` = sha256 del token (nunca se guarda el token), `userId`, `createdAt`, `expiresAt` (30 días, absoluto); se borra en cascada con el usuario |

**Endpoints** (errores `{ error, message }`, como el resto de la API)

| Ruta | Éxito | Errores |
|---|---|---|
| `POST /auth/register` `{email, password, name?}` | 201 + cookie (queda logueado) + `{ user }` | 400 `invalid_email` / `weak_password`, 409 `email_taken`, 429 |
| `POST /auth/login` `{email, password}` | 200 + cookie + `{ user }` | 401 `invalid_credentials` (el mismo para email inexistente y clave incorrecta), 429 |
| `POST /auth/logout` | 204, borra la sesión y la cookie | Idempotente |
| `GET /auth/me` | 200 `{ user }` | 401 `unauthenticated` |

**Decisiones**
- **Contraseña:** argon2id con `@node-rs/argon2` (parámetros por defecto, del nivel que recomienda OWASP).
  Entre 10 y 256 caracteres; el máximo evita hashear entradas enormes. Si el email no existe, igual se
  verifica contra un hash ficticio, para que el tiempo de respuesta no revele qué cuentas existen.
- **Cookie `sid`:** token aleatorio de 32 bytes, `HttpOnly`, `SameSite=Lax`, `Path=/` y `Secure` según
  `COOKIE_SECURE` (false en localhost). Al hacer login o registro se emite un token nuevo, contra la
  fijación de sesión.
- **CSRF:** `SameSite=Lax` más el guard de Origin que ya existe. Además, una petición que no es GET y
  **trae la cookie de sesión** tiene que traer un `Origin` permitido; sin Origin → 403. Los navegadores
  siempre lo envían, así que esto solo afecta a clientes que no son navegadores y usan la cookie.
- **Rate limit:** `@fastify/rate-limit` con Redis como almacén (sobrevive a reinicios). Login y registro:
  10 intentos cada 15 minutos por IP y por email.
- **Sesiones en Postgres y no en Redis:** son datos durables, y Redis está configurado como cola
  (`noeviction`). Una sesión vencida se rechaza al leerla y el barrido periódico la borra.
- **Estructura:** `features/auth/`, con `index.ts` como API pública (`authRoutes` y `requireUser`, que
  agrega `request.user`). El cliente de Prisma se crea en `lib/db.ts` y llega por `buildApp(deps.db)`.
- **Prisma en las imágenes:** el cliente se genera en `src/generated/prisma` (ignorado por git), con
  `prisma generate` en el `postinstall` de `apps/server` y en el build de la imagen. En compose, un
  servicio `migrate` de una sola ejecución corre `prisma migrate deploy`, y `server` espera a que
  termine bien.

**Dependencias nuevas** (server): `@prisma/client`, `@prisma/adapter-pg` y `pg` (cliente y driver),
`prisma` (CLI, dev, para migrar y generar), `@node-rs/argon2` (hash, binarios precompilados, sin
compilar), `@fastify/cookie` y `@fastify/rate-limit` (plugins oficiales). `allowBuilds` para
`@prisma/engines` y `prisma` (descargan el motor de migraciones; verificado).

## 4. Archivos
- `apps/server/prisma/schema.prisma`, `apps/server/prisma/migrations/`, `apps/server/prisma.config.ts`
- `apps/server/src/lib/db.ts`, `apps/server/src/plugins/cookies.ts`
- `apps/server/src/features/auth/`: `index.ts`, `routes.ts`, `service.ts` (registro, login, sesiones),
  `passwords.ts`, `guard.ts` (`requireUser` y el CSRF con cookie), cada uno con su test cuando aplique
- `apps/server/test/integration/auth.test.ts`, con Postgres real (una base `latexweb_test` que crea y migra
  un `globalSetup`)
- Modificar: `config.ts` (`DATABASE_URL`, `COOKIE_SECURE`), `app.ts`, `index.ts`, `package.json`,
  `pnpm-workspace.yaml`, `Dockerfile`, `docker-compose.yml`, `.gitignore`, `.env.example` y CLAUDE.md

## 5. Pasos
1. **Base de datos y servicio de cuentas:** Prisma (schema, migración inicial, config y generación),
   `lib/db.ts`, `service.ts` y `passwords.ts` (registro, login, creación, lectura y borrado de sesiones,
   barrido de vencidas), la base de test y los tests de integración del servicio contra Postgres real.
2. **API, cookies y protecciones:** rutas, cookie, `requireUser`, regla CSRF, rate limit con Redis y un
   test de punta a punta (registro → me → logout → me 401 → login, más el rate limit). Docker: servicio
   `migrate`, generación en la imagen y `DATABASE_URL` en compose. Documentación.

Al final: verificación en vivo con `docker compose up` y `revisor-seguridad` sobre `features/auth`.

## 6. Criterios de aceptación
- [x] Registro → cookie `sid` httpOnly → `GET /auth/me` devuelve el usuario; tras logout, `/auth/me` → 401.
- [x] El hash en la base es argon2id, y en `Session.id` está el sha256 del token, no el token.
- [x] Login con email inexistente y con clave incorrecta da el mismo 401 y un tiempo comparable.
- [x] El intento número 11 en 15 minutos → 429.
- [x] Un POST con la cookie de sesión y sin Origin, o con un Origin ajeno → 403.
- [x] Una sesión vencida da 401 y el barrido la borra.
- [x] `docker compose up -d --build` migra la base sola y la API de auth funciona en el stack.
- [x] `pnpm test`, `typecheck`, `lint` y `test:integration` en verde.

## 7. Riesgos
- **Enumeración de cuentas:** el registro revela si un email ya existe (409). Es aceptable con rate
  limit; el login no lo revela.
- **`COOKIE_SECURE=false`** solo es aceptable en localhost por http; en producción tiene que ser true
  (spec `despliegue`).
- **Prisma 7 es reciente** (`latest` de npm ya apunta a una RC de la 8): se fija la 7.10.1 exacta.
- **Hash bloqueante:** argon2 en `@node-rs` corre fuera del hilo principal (async), pero cuesta CPU y
  memoria. El rate limit acota el abuso.
