# syntax=docker/dockerfile:1
# Worker de compilación. Se construye con la raíz del repo como contexto (el lockfile y `shared/` son
# del workspace): `docker build -f compiler/Dockerfile .`. Lo que entra al contexto lo decide
# compiler/Dockerfile.dockerignore. La imagen de TeX Live de las compilaciones es otra:
# compiler/texlive/Dockerfile. Ver docs/specs/docker-compose.md.
#
# Corre como root dentro de su contenedor: necesita el socket de Docker, que de todos modos equivale
# a root sobre el host. Las compilaciones se lanzan con un uid sin privilegios (resolveContainerUser).

# Binario estático de la CLI de Docker (lanza las compilaciones por el socket).
FROM docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker-cli

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
# pnpm exactamente como lo fija `packageManager` (versión y hash sha512, que corepack verifica).
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
RUN pnpm install --frozen-lockfile --prod --filter "@latexweb/compiler..."

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY compiler/tsconfig.json compiler/
COPY compiler/src compiler/src
# Disco de trabajo del worker (volumen latexweb-compile-work, solo suyo).
RUN mkdir -p /data/work && chmod 0700 /data/work
WORKDIR /app/compiler
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]
