# Roadmap

## Plan vigente (2026-11-17)
Objetivo: un clon de Overleaf usable. Cada bloque termina en algo que se usa desde el navegador y tiene
**una** spec con pocos pasos grandes (CLAUDE.md, "Forma de trabajo").

| # | Bloque | Qué se puede hacer al terminar | Estado |
|---|---|---|---|
| — | compilación, auth (API) | compilar por API, registrarse e iniciar sesión por API | hecho |
| 1 | Cimientos | entrar a la web, registrarse, iniciar y cerrar sesión. Base de código reordenada | spec: `cimientos.md` |
| 2 | Proyectos y editor | crear o importar un proyecto, subir imágenes, editar, compilar y ver el PDF | pendiente |
| 3 | Colaboración | compartir con roles, editar entre varios en vivo con cursores y presencia | pendiente |
| 4 | Feedback de compilación | panel de errores que salta a la línea, SyncTeX (código ↔ PDF), autocompilar | pendiente |
| 5 | Editor visual | alternar código/visual sobre el mismo documento, barra de formato, insertar figuras | pendiente |
| 6 | Cierre | historial de versiones, cuotas, despliegue | pendiente |

Pendientes menores y hallazgos de seguridad: `docs/backlog.md`.

## Decisiones de arquitectura
- **Drizzle en lugar de Prisma** (bloque 1). Con Prisma había que generar el cliente (`postinstall`,
  `src/generated`), descargar binarios (`allowBuilds`, aviso de openssl), mantener un servicio `migrate` y
  una etapa extra del Dockerfile, y `prisma.config.ts` leía `process.env` fuera de `config.ts`. Con
  Drizzle el esquema es TypeScript, los tipos salen del esquema sin generar nada, las migraciones son SQL
  versionado y el server las aplica al arrancar. Con 2 tablas, ahora es el momento barato de cambiar.
- **Un solo origen para el navegador** (bloque 1): la API pasa a `/api` y Vite hace de proxy de `/api` y
  `/collab`. Sin CORS, cookies simples y el WebSocket en el mismo host.
- **Server y compiler no comparten disco** (bloque 2): el server escribe una instantánea del proyecto en
  MinIO y encola. El compiler baja la instantánea a **su** disco de trabajo, compila y sube PDF y log a
  MinIO. Se quitan el volumen compartido `compile-storage`, `COMPILE_STORAGE_DIR` en el server, los
  chequeos de espacio en la API y `POST /compilations` anónimo con multipart: se compilan proyectos.
- **Contenido de los archivos** (bloque 2): un `Y.Doc` por proyecto, persistido en Postgres. Tiene el
  árbol de archivos (`Y.Map` id → {path, tipo}) y un `Y.Text` por archivo de texto. Los binarios
  (imágenes, PDF) van a MinIO. Así el editor nace colaborativo, y compilar o exportar un zip es
  serializar el `Y.Doc` y los binarios.
- **Editor visual = decoraciones de CodeMirror 6** (bloque 5) sobre el mismo `Y.Text`, como el Visual
  Editor de Overleaf. No usar un editor WYSIWYG aparte con conversión LaTeX ↔ HTML: pierde información y
  rompe la colaboración.

## Bloques

### 1. Cimientos — `docs/specs/cimientos.md`
Prisma → Drizzle, API bajo `/api`, proxy de Vite, esqueleto de la web (router, TanStack Query, Tailwind,
cliente de la API) con registro, login, logout y una página de inicio protegida. Orden de carpetas
(`apps/compiler/texlive`), `.env` en `pnpm dev` y CI en GitHub Actions.

### 2. Proyectos y editor
Base: el borrador `docs/specs/proyectos.md`, a reescribir con estas decisiones.
- Backend: modelos `projects`, `project_members` (solo dueño por ahora), `files`, `compilations`;
  `assertProjectAccess`; CRUD de proyectos y archivos; import y export zip seguro (yauzl/yazl); bucket de
  MinIO; Hocuspocus con auth de sesión en el upgrade y persistencia del `Y.Doc` en Postgres.
- Compilación: `POST /api/projects/:id/compile` → instantánea en MinIO → cola → el compiler compila desde
  MinIO → PDF y log en MinIO. Se retira la subida multipart y el disco compartido.
- Web: lista de proyectos (crear, importar zip, renombrar, borrar); la pantalla del editor con árbol de
  archivos (crear, renombrar, mover, borrar, subir imágenes arrastrando), CodeMirror con resaltado LaTeX,
  vista previa de imágenes, botón Compilar, visor PDF.js y el log crudo.

### 3. Colaboración
Roles dueño, editor y lector; enlaces para compartir (con rol, vencimiento y revocables). `readOnly` en
Hocuspocus para lectores. Cursores y selecciones de otros usuarios (awareness de y-codemirror.next), lista
de conectados, árbol de archivos en vivo (ya está en el `Y.Doc`). Límites de tamaño de mensaje y de
documento.

### 4. Feedback de compilación
Parseo del log (`-file-line-error`) a errores y advertencias con archivo y línea; `output.blg` de biber.
Panel de errores y marcas en el editor que saltan a la línea. SyncTeX (`-synctex=1`) en las dos
direcciones. Compilar con Ctrl+S y opcionalmente al dejar de escribir.

### 5. Editor visual
Modo visual en CodeMirror con decoraciones y widgets: títulos de sección, negrita, cursiva, listas,
fórmulas renderizadas (KaTeX), figuras con la imagen del proyecto, tablas simples. La fuente vuelve a
aparecer donde está el cursor. Barra de herramientas (formato, secciones, insertar figura, tabla o
fórmula) que funciona en los dos modos. Arrastrar una imagen al editor inserta la figura.

### 6. Cierre
Historial (instantáneas del `Y.Doc`, diff y restaurar), límites y cuotas por usuario (compilaciones
concurrentes, tamaño de proyecto y de cuenta, limpieza en MinIO), despliegue (Docker sin root o gVisor
para el worker, HTTPS y `COOKIE_SECURE`).

## Historial del plan
- Hasta el 2026-11-17 el plan era primero el backend completo (bloques B a E), con el frontend al final.
  Se cambió porque después de compilación y auth todavía no había nada usable en el navegador.
- Lo hecho antes de este plan está en `docs/specs/estructura-monorepo.md`, `compilacion.md`,
  `docker-compose.md` y `auth.md`.
