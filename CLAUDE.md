# Overleaf Clone

Editor LaTeX web con compilación, vista PDF y colaboración en tiempo real.

## Stack
- Monorepo pnpm workspaces, TypeScript estricto en todo
- apps/web: React + Vite, CodeMirror 6, PDF.js
- apps/server: Fastify (API REST) + Hocuspocus (Yjs) en el mismo proceso, WebSocket en /collab; PostgreSQL con Prisma, sesiones con cookies httpOnly
- apps/compiler: worker BullMQ (Redis) que compila en Docker con TeX Live + latexmk
- Almacenamiento de archivos: MinIO (API S3)
- packages/shared: tipos compartidos

## Comandos
- Instalar: `pnpm install`
- Levantar servicios: `docker compose up -d`
- Dev: `pnpm dev`
- Tests: `pnpm test`
- Lint y tipos: `pnpm lint && pnpm typecheck`

## Reglas
- Antes de una funcionalidad nueva, debe existir su spec en docs/specs/
- Pasos pequeños: implementar, correr tests, luego seguir
- Nunca habilitar shell-escape en la compilación de LaTeX
- Toda compilación corre sin red y con límites de CPU, RAM y tiempo
- No agregar dependencias sin explicar por qué
- Mensajes de commit en español, formato: `tipo: descripción`