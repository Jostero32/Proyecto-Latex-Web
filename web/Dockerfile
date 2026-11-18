# syntax=docker/dockerfile:1
# Frontend. Se construye con la raíz del repo como contexto (el lockfile y `shared/` son del
# workspace): `docker build -f web/Dockerfile .`. Lo que entra al contexto lo decide
# web/Dockerfile.dockerignore. Ver docs/specs/docker-compose.md.
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
# vite y el plugin de React son devDependencies de web: hacen falta para el build y para `preview`.
RUN pnpm install --frozen-lockfile --filter "@latexweb/web..."

COPY web web
RUN pnpm --filter @latexweb/web build
WORKDIR /app/web
USER node
EXPOSE 5173
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
