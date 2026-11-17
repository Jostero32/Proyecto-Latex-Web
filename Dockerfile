# syntax=docker/dockerfile:1
# Imágenes de las apps para docker compose (perfil `apps`). Ver docs/specs/docker-compose.md.
# Un target por app: server, compiler y web. La imagen de TeX Live de las compilaciones se construye
# aparte (apps/compiler/docker/Dockerfile).
#
# Sin paso de build: las apps de Node corren con tsx, igual que en desarrollo. Se arrancan con
# `node` directamente (no `pnpm start`) para que las señales de apagado lleguen al proceso.

# Binario estático de la CLI de Docker para el worker (lanza las compilaciones por el socket).
FROM docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker-cli

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base
# pnpm con la misma versión que `packageManager`, instalado en una ruta legible por cualquier usuario.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm && corepack prepare pnpm@12.18.0 --activate && chmod -R a+rX /opt/corepack
WORKDIR /app

# Primero los manifiestos, para que la capa de dependencias se reutilice si no cambian.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/compiler/package.json apps/compiler/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
# Raíz de almacenamiento compartida (volumen latexweb-compile-storage). Docker inicializa un volumen
# vacío copiando este directorio de la imagen, con su dueño: así el usuario `node` (uid 1000) del
# server puede crear las carpetas de cada compilación.
RUN mkdir -p /data/compilations && chown node:node /data/compilations

# --- API REST + colaboración ---
FROM base AS server
COPY apps/server apps/server
WORKDIR /app/apps/server
USER node
# SERVER_HOST=0.0.0.0 lo define docker-compose.yml y no la imagen: un `docker run -p` suelto no debe
# publicar en todas las interfaces una API sin autenticación.
ENV SERVER_PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "/app/node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# --- Worker de compilación ---
# Corre como root dentro de su contenedor: necesita el socket de Docker, que de todos modos equivale
# a root sobre el host. Las compilaciones se lanzan como 1000:1000 (resolveContainerUser).
FROM base AS compiler
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY apps/compiler/package.json apps/compiler/tsconfig.json apps/compiler/
COPY apps/compiler/src apps/compiler/src
WORKDIR /app/apps/compiler
CMD ["node", "/app/node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# --- Frontend ---
FROM base AS web
COPY apps/web apps/web
RUN pnpm --filter @latexweb/web build \
  # `vite preview` compila vite.config.ts en node_modules/.vite-temp al arrancar: tiene que poder
  # escribir ahí el usuario `node`, sin darle el resto de node_modules.
  && mkdir -p apps/web/node_modules/.vite-temp \
  && chown node:node apps/web/node_modules/.vite-temp
WORKDIR /app/apps/web
USER node
EXPOSE 5173
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
