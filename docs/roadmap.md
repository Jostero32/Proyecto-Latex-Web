# Roadmap

## Plan vigente (2026-11-17)
Objetivo: un clon de Overleaf usable. Pocas specs, cada una con 3 o 4 pasos grandes (CLAUDE.md).

| # | Spec | Qué queda andando | Estado |
|---|---|---|---|
| — | compilación, auth | compilar por API, registrarse e iniciar sesión por API | hecho |
| 1 | `backend.md` (4 pasos) | reestructura y Drizzle; proyectos, archivos, imágenes y permisos; colaboración persistida; compilación de proyectos con errores y SyncTeX | hecho |
| 2 | `frontend.md` | login, lista de proyectos, editor con árbol de archivos e imágenes, colaboración en vivo con cursores, compilar, visor PDF, panel de errores, SyncTeX | pasos 1 a 3 hechos (interfaz, API, edición en vivo) |
| 3 | `editor-visual.md` | modo visual sobre el mismo documento, barra de formato, insertar figuras y fórmulas | pendiente |
| 4 | `cierre.md` | historial de versiones, cuotas, despliegue | pendiente |

Pendientes menores y hallazgos de seguridad: `docs/backlog.md`.

## Decisiones de arquitectura
- **Drizzle en lugar de Prisma.** Con Prisma había que generar el cliente (`postinstall`, `src/generated`),
  descargar binarios (`allowBuilds`, aviso de openssl) y mantener un servicio `migrate` y una etapa extra
  del Dockerfile. Además, `prisma.config.ts` leía `process.env` fuera de `config.ts`. Con Drizzle el
  esquema es TypeScript, no hay que generar nada, las migraciones son SQL versionado y el server las aplica
  al arrancar.
- **Estructura plana:** `server/`, `compiler/`, `web/`, `shared/` y `docs/` en la raíz, sin `apps/` ni
  `packages/`. Con 4 paquetes, ese nivel extra no agrupa nada. Las carpetas internas existen solo si
  agrupan varios archivos.
- **Tests en `<app>/test/`**, uno por feature de punta a punta contra la infraestructura real, y unitarios
  solo para lógica de seguridad. Antes había tantas líneas de test como de código, con un paso chico por
  cada pieza.
- **Server y compiler no comparten disco:** se comunican por Redis (cola) y MinIO (entradas y resultados).
  Se compilan proyectos; desaparece la subida anónima.
- **Dónde vive cada cosa:** el árbol de archivos en Postgres; el texto en un `Y.Doc` por proyecto (persistido
  en Postgres), que es lo que se edita en vivo y lo que se compila; los binarios en MinIO.
- **Un solo origen para el navegador:** la API bajo `/api`, y Vite como proxy de `/api` y `/collab` (spec
  del frontend). La API está documentada en `/api/docs` (Swagger).
- **Editor visual = decoraciones de CodeMirror 6** sobre el mismo `Y.Text`, como el Visual Editor de
  Overleaf. No usar un editor WYSIWYG aparte con conversión LaTeX ↔ HTML: pierde información y rompe la
  colaboración.

## Después del backend
- **Frontend:** React Router, TanStack Query y Tailwind. Pantallas de login, registro y proyectos (crear,
  importar zip, compartir). Editor: árbol de archivos con subida de imágenes arrastrando, CodeMirror con
  y-codemirror.next (cursores y presencia), Compilar con Ctrl+S, visor PDF.js, panel de errores que salta a
  la línea, SyncTeX en el navegador a partir de `output.synctex.gz`.
- **Editor visual:** decoraciones y widgets para secciones, negrita, cursiva, listas, fórmulas (KaTeX),
  figuras con la imagen del proyecto y tablas simples. La fuente vuelve a aparecer donde está el cursor.
  Barra de herramientas que sirve en los dos modos.
- **Cierre:** historial (instantáneas del `Y.Doc`, diff y restaurar), cuotas y límites por usuario,
  despliegue (Docker sin root o gVisor para el worker, HTTPS, `COOKIE_SECURE`, migrar antes de arrancar).

## Historial del plan
- Hasta el 2026-11-17 el plan iba en specs chicas con muchos pasos, cada uno muy testeado. Se cambió a
  pocas specs con pasos grandes porque, después de compilación y auth, todavía no había nada usable.
- Lo hecho antes está en `docs/specs/estructura-monorepo.md`, `compilacion.md`, `docker-compose.md` y
  `auth.md`. Estas specs quedan como registro histórico, con las rutas de entonces.
