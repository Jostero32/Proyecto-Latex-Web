# syntax=docker/dockerfile:1
# Imágenes de las apps para docker compose. Ver docs/specs/docker-compose.md.
# Un target por app: server, compiler y web. La imagen de TeX Live de las compilaciones se construye
# aparte (apps/compiler/docker/Dockerfile).
#
# Sin paso de build: las apps de Node corren con tsx (dependencia de cada app), igual que en
# desarrollo. Se arrancan con `node` directamente (no `pnpm start`) para que las señales de apagado
# lleguen al proceso. Cada imagen instala solo las dependencias de su app.

# Binario estático de la CLI de Docker para el worker (lanza las compilaciones por el socket).
FROM docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker-cli

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base
# pnpm exactamente como lo fija `packageManager` (versión y hash sha512, que corepack verifica),
# instalado en una ruta legible por cualquier usuario.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json ./
RUN corepack enable pnpm && corepack install && chmod -R a+rX /opt/corepack

# Manifiestos del workspace (la capa de dependencias se reutiliza si no cambian).
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/compiler/package.json apps/compiler/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
# Raíz de almacenamiento compartida (volumen latexweb-compile-storage). Docker inicializa un volumen
# vacío copiando este directorio de la imagen, con su dueño: así el usuario `node` (uid 1000) del
# server puede crear las carpetas de cada compilación.
RUN mkdir -p /data/compilations && chown node:node /data/compilations

# --- API REST + colaboración ---
FROM base AS server
RUN pnpm install --frozen-lockfile --prod --filter "@latexweb/server..."
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
WORKDIR /app/apps/server
USER node
# SERVER_HOST=0.0.0.0 lo define docker-compose.yml y no la imagen: un `docker run -p` suelto no debe
# publicar en todas las interfaces una API sin autenticación.
ENV SERVER_PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# --- Worker de compilación ---
# Corre como root dentro de su contenedor: necesita el socket de Docker, que de todos modos equivale
# a root sobre el host. Las compilaciones se lanzan con un uid sin privilegios (resolveContainerUser).
FROM base AS compiler
RUN pnpm install --frozen-lockfile --prod --filter "@latexweb/compiler..."
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY apps/compiler/tsconfig.json apps/compiler/
COPY apps/compiler/src apps/compiler/src
WORKDIR /app/apps/compiler
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# --- Frontend ---
FROM base AS web
# vite y el plugin de React son devDependencies de web: hacen falta para el build y para `preview`.
RUN pnpm install --frozen-lockfile --filter "@latexweb/web..."
COPY apps/web apps/web
RUN pnpm --filter @latexweb/web build
WORKDIR /app/apps/web
USER node
EXPOSE 5173
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
