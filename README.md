# latexweb

Editor LaTeX web, al estilo de Overleaf: proyectos con imágenes, compilación a PDF en un sandbox,
colaboración en tiempo real con cursores y SyncTeX (del código al PDF y del PDF al código).

## Requisitos
- Docker (Docker Desktop o Engine 28 o posterior).
- Para desarrollar fuera de los contenedores: Node 22 (`.nvmrc`) y pnpm por corepack (`corepack enable pnpm`).

## Levantar todo con Docker
```sh
cp .env.example .env        # opcional: todo tiene valores por defecto
docker compose up -d --build
```
La primera vez tarda: construye la imagen de TeX Live completa (~5 GB). Después:

| Servicio | URL en el equipo |
|---|---|
| Web | http://127.0.0.1:55173 |
| API (Swagger en `/api/docs`) | http://127.0.0.1:53000/api |
| Consola de MinIO | http://127.0.0.1:59001 |
| Postgres / Redis | `127.0.0.1:55432` / `127.0.0.1:56379` |

Los puertos son poco comunes a propósito, para no chocar con otros proyectos, y solo se publican en
`127.0.0.1`. El servicio `texlive-image` solo construye la imagen de las compilaciones y termina:
es normal verlo detenido.

> El worker de compilación monta el socket de Docker (equivale a root sobre el host): este compose es
> para uso local, no para producción.

## Desarrollo con recarga en caliente
```sh
docker compose up -d postgres redis minio texlive-image
pnpm install
pnpm dev                    # server, compiler y web (Vite en http://127.0.0.1:55173)
```

## Comandos
| Comando | Qué hace |
|---|---|
| `pnpm test` | Tests de todas las apps (con postgres, redis y minio levantados) |
| `pnpm test:compile` | Compilaciones reales con Docker y TeX Live (lentas) |
| `pnpm lint` / `pnpm typecheck` | ESLint y TypeScript |
| `pnpm db:generate` | Genera la migración después de cambiar `server/src/schema.ts` |

## Estructura
Monorepo con pnpm workspaces: las apps comparten los contratos de la API y la validación de rutas
(`shared/`), así que hay un solo lockfile y un `node_modules/` en la raíz.

```
server/     API REST (Fastify) y colaboración (Hocuspocus/Yjs), con Postgres y MinIO
compiler/   worker que compila en contenedores sin red; texlive/ es la imagen de TeX Live
web/        React + Vite: editor (CodeMirror), visor PDF (PDF.js)
shared/     tipos de la API, códigos de error y utilidades puras comunes
docs/       roadmap, backlog y specs de cada funcionalidad
```
Cada app tiene su `Dockerfile`, su `vitest.config.ts` y sus tests en `test/`. Plan y estado:
[`docs/roadmap.md`](docs/roadmap.md). Convenciones de trabajo: [`CLAUDE.md`](CLAUDE.md).
