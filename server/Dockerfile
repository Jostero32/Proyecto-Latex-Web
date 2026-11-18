# syntax=docker/dockerfile:1
# API REST + colaboración. Se construye con la raíz del repo como contexto (el lockfile y `shared/` son
# del workspace): `docker build -f server/Dockerfile .`. Lo que entra al contexto lo decide
# server/Dockerfile.dockerignore. Ver docs/specs/docker-compose.md.
#
# Sin paso de build: corre con tsx, igual que en desarrollo, y arranca con `node` directamente (no
# `pnpm start`) para que las señales de apagado lleguen al proceso.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
# pnpm exactamente como lo fija `packageManager` (versión y hash sha512, que corepack verifica),
# instalado en una ruta legible por cualquier usuario.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json ./
RUN corepack enable pnpm && corepack install && chmod -R a+rX /opt/corepack

# Manifiestos del workspace primero: la capa de dependencias se reutiliza si no cambian.
COPY pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY server/package.json server/
COPY compiler/package.json compiler/
COPY web/package.json web/
COPY shared shared
# Solo producción y sin scripts. Las migraciones (drizzle/) las aplica el server al arrancar.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@latexweb/server..."

COPY server/tsconfig.json server/
COPY server/src server/src
COPY server/drizzle server/drizzle
WORKDIR /app/server
USER node
# SERVER_HOST=0.0.0.0 lo define docker-compose.yml y no la imagen: un `docker run -p` suelto no debe
# publicar en todas las interfaces una API sin autenticación.
ENV SERVER_PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]
