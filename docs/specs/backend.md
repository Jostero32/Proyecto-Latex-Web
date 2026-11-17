# Spec: terminar el backend (4 pasos)

## 1. Objetivo
Dejar el backend completo para que el frontend sea solo pantallas: proyectos con archivos e imágenes,
permisos y compartir, edición colaborativa persistida y compilación de proyectos con errores parseados.
Antes, reordenar el código (estructura plana, Drizzle, tests en `test/`) para no construir encima de lo
que se va a cambiar.

## 2. Alcance
**Incluye**: los 4 pasos de abajo. **No incluye**: frontend, historial de versiones, cuotas por usuario,
recuperación de contraseña, invitaciones por email ni despliegue (roadmap).

## 3. Diseño

**Estructura** (CLAUDE.md): `apps/server` → `server/`, `apps/compiler` → `compiler/`, `apps/web` → `web/`,
`packages/shared` → `shared/`, `fixtures/latex` → `compiler/test/fixtures/`, `apps/compiler/docker` →
`compiler/texlive/`. En el server se eliminan `plugins/`, `lib/` y `generated/`: cookies y multipart se
registran en `app.ts`, y `lib/` pasa a `http.ts` y `storage.ts`. En el compiler se aplanan `worker/`,
`docker/` y `workspace/`. Los tests pasan a `<app>/test/` y se recortan a la regla de CLAUDE.md.

**Datos (Drizzle, `server/src/schema.ts`)**

| Tabla | Columnas clave |
|---|---|
| `users`, `sessions` | igual que hoy (snake_case) |
| `projects` | `id`, `name`, `main_file` (`main.tex`), `engine` (`pdflatex`), `created_at`, `updated_at` |
| `project_members` | `project_id`, `user_id`, `role` (`owner` \| `editor` \| `viewer`); PK `(project_id, user_id)` |
| `files` | `id`, `project_id`, `path`, `path_key` (NFC + minúsculas, único por proyecto), `kind` (`text` \| `binary`), `size`, `updated_at` |
| `documents` | `project_id` (PK), `state` (bytea: update de Yjs), `updated_at` |
| `share_links` | `id`, `project_id`, `token_hash` (sha256), `role`, `created_by`, `expires_at?`, `revoked_at?` |
| `compilations` | `id` (uuid), `project_id`, `user_id`, `created_at` (se crea en el paso 4) |

**Dónde vive cada cosa**
- El **árbol** (rutas) está en `files` (Postgres): es lo que se valida y se autoriza.
- El **texto** de los archivos `text` vive en un `Y.Doc` por proyecto (`project:<id>`), con un `Y.Map`
  `files` que guarda un `Y.Text` por archivo (clave: id del archivo), persistido en `documents`. Un mapa
  y no un tipo raíz por archivo: un tipo raíz de Yjs no se puede borrar. Es la única copia del texto: lo que se edita en
  vivo es lo que se compila y se exporta.
- Los **binarios** (imágenes, PDF, fuentes) van a MinIO: `projects/<projectId>/files/<fileId>`.
- Se considera texto un archivo con extensión conocida (`.tex .bib .cls .sty .bst .txt .md`…) y UTF-8
  válido; el resto es binario.
- La API REST escribe el texto con `hocuspocus.openDirectConnection`, así los editores conectados ven
  el cambio al instante. Para leer usa el documento abierto en memoria o, si no está abierto, la fila de
  `documents` (cerrar una conexión directa guarda el documento entero: no vale la pena en una lectura).

**Permisos**: `assertProjectAccess(userId, projectId, action)`. Si el usuario no es miembro, 404 (no revela
que el proyecto existe); si su rol no alcanza, 403. Lector: ver, exportar y compilar. Editor: además,
escribir archivos y cambiar `main_file` y `engine`. Dueño: además, renombrar o borrar el proyecto y
gestionar miembros y enlaces.

**Endpoints** (todos con sesión, errores `{ error, message }`)
- Proyectos: `POST /api/projects` (crea con `main.tex` de plantilla), `GET /api/projects` (los míos con mi
  rol), `GET`, `PATCH` y `DELETE /api/projects/:id`.
- Archivos: `GET /api/projects/:id/files` (árbol plano), `POST` multipart (crear o reemplazar por ruta),
  `GET /:fileId` (contenido; binarios con `nosniff` y `attachment`, salvo imágenes en `inline`),
  `PUT /:fileId` (texto), `PATCH /:fileId {path}` (renombrar o mover) y `DELETE /:fileId`.
- Zip: `POST /api/projects/import` y `GET /api/projects/:id/export`, con yauzl y yazl en streaming. Topes de
  entradas y de bytes **reales** descomprimidos; se rechazan symlinks, rutas inválidas y colisiones; se
  ignoran `__MACOSX/`, los ocultos y `latexmkrc`.
- Miembros y enlaces (dueño): `GET`, `PATCH {role}` y `DELETE /api/projects/:id/members/:userId`;
  `POST`, `GET` y `DELETE /api/projects/:id/share-links` (el token se ve una sola vez);
  `POST /api/share/:token/join` (si ya era miembro, se queda con el rol más alto).
- Compilación: `POST /api/projects/:id/compile`, `GET /api/compilations/:id` (estado y diagnósticos) y
  `GET /api/compilations/:id/{pdf,log,synctex}`; solo para miembros del proyecto.

**Colaboración**: el upgrade de `/collab` valida la cookie de sesión antes de aceptar. En `onConnect`, el
documento `project:<id>` exige `assertProjectAccess`, y el lector queda con `connectionConfig.readOnly`.
`onLoadDocument` y `onStoreDocument` (debounce de 2 s, máximo 10 s) leen y guardan en `documents`. Al
quitar a un miembro o bajarlo a lector, se cierran sus conexiones. Tope de tamaño por documento
(`DOC_MAX_BYTES`). Cuando cambia el árbol por REST, se envía un mensaje stateless `files-changed` a los
conectados.

**Compilación de proyectos**
- El server serializa el `Y.Doc` y escribe una instantánea en `compilations/<cid>/input/`. Los binarios se
  copian del lado de MinIO, con CopyObject. Después inserta la fila y encola `{compilationId, mainFile,
  engine}`.
- El compiler baja `input/` a **su** volumen de trabajo, compila igual que hoy (sin red, sin shell-escape,
  con límites y con `-synctex=1`) y sube `output.pdf`, `output.log` y `output.synctex.gz` a
  `compilations/<cid>/`. Devuelve en el resultado del job los diagnósticos del log: `{file, line, level,
  message}[]`, de `-file-line-error` y `output.blg`.
- La retención la hace una regla de ciclo de vida del bucket sobre `compilations/` (1 día), sin barrido
  propio.
- Se retiran `POST /compilations` anónimo, el volumen compartido `compile-storage`, `COMPILE_STORAGE_DIR` y
  los chequeos de disco en el server. El compiler pasa a estar en una red con MinIO; las compilaciones
  siguen sin red.

**Dependencias**
- Nuevas:
  - `drizzle-orm` y `drizzle-kit` (dev): ORM sin generación de código ni binarios;
  - `@aws-sdk/client-s3` (server y compiler): cliente S3 estándar, para MinIO;
  - `yauzl` y `yazl`: zip en streaming.
- Se quitan: `@prisma/client`, `@prisma/adapter-pg` y `prisma`.

**Config**: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `PROJECT_MAX_BYTES`
(200 MB), `PROJECT_MAX_FILES` (500), `FILE_MAX_BYTES` (50 MB; agregado en el paso 2: las subidas se leen
en memoria) y `DOC_MAX_BYTES` (10 MB, paso 3).

## 4. Pasos
1. **Reestructura y Drizzle.** Mover las carpetas (con `git mv`) y aplanar. Drizzle con `users` y
   `sessions`, migrar al arrancar, prefijo `/api`. Tests a `test/`, con el recorte. Ajustar compose, el
   Dockerfile (sin `migrate` ni `server-build`), vitest (`test` y `test:compile`), `.env` en dev y CI en
   GitHub Actions con servicios postgres, redis y minio. Sin cambios de comportamiento.
2. **Proyectos, archivos y permisos.** Tablas, bucket y `storage.ts`. CRUD de proyectos y archivos, con el
   texto en el `Y.Doc` (persistencia de Hocuspocus) y los binarios en MinIO. Zip, roles, miembros y
   enlaces. Hasta el paso 3, `/collab` rechaza todas las conexiones.
   Tests: `projects.test.ts` (CRUD, imágenes y viaje de ida y vuelta del zip), `sharing.test.ts` (matriz
   de roles y enlaces) y unitarios del zip malicioso.
3. **Colaboración.** Sesión en el upgrade, acceso y `readOnly` en `onConnect`, cierre de conexiones al
   quitar permisos, tope de documento y `files-changed`. Test: dos clientes Yjs con cookies editan y se
   sincronizan, un lector no puede escribir y un no miembro es rechazado. Lo editado aparece en
   `GET /files/:id` y sobrevive a reiniciar el server.
4. **Compilación de proyectos.** Instantánea en MinIO, compiler desde y hacia MinIO, `compilations` con
   acceso por proyecto, diagnósticos y SyncTeX, ciclo de vida del bucket, y retirar lo viejo. Tests:
   `compile.test.ts` del server (encola y controla el acceso) y `pnpm test:compile` con los 6 fixtures como
   proyectos.

Al final: verificación en vivo en el stack de compose y `/security-review`.

## 5. Criterios de aceptación
- [ ] `docker compose up -d --build` con la base vacía crea las tablas solo y no tiene servicio `migrate`.
- [ ] Crear un proyecto, importar los 6 fixtures como zip, compilarlos y bajar PDF, log y synctex: los 6 dan
      `success`. Un error de LaTeX aparece en `diagnostics` con archivo y línea.
- [ ] Un no miembro recibe 404 en el proyecto, los archivos, la compilación y sus artefactos. Un lector
      recibe 403 al escribir y no puede escribir por WebSocket. Un editor no gestiona miembros.
- [ ] Una edición por WebSocket se ve en `GET /files/:id` y en la siguiente compilación.
- [ ] Un zip con `../`, con un symlink, con demasiadas entradas o que se infla por encima del tope se rechaza
      sin escribir nada.
- [ ] No quedan referencias a Prisma, a `apps/` ni a `packages/`. `pnpm test`, `typecheck`, `lint`,
      `test:compile` y CI pasan.

## 6. Riesgos
- **Postgres y MinIO no son transaccionales juntos:** primero se escribe el objeto y después la fila; al
  borrar, primero la fila. Un fallo deja objetos huérfanos, nunca filas sin objeto (barrido en el
  backlog).
- **Documento en memoria:** un proyecto enorme ocupa RAM en el server mientras está abierto; lo acota
  `DOC_MAX_BYTES`. Un lector malicioso no puede inflarlo: es `readOnly`.
- **Migraciones al arrancar con varias réplicas:** el migrador de Drizzle no toma un lock. Hoy hay una sola
  réplica; en despliegue, migrar en un paso previo.
- **Ciclo de vida en `pgsty/minio`:** verificarlo en el paso 4. Si no funciona, el barrido va en el worker.
- **Bases locales:** las tablas cambian de nombre, así que hay que descartar el volumen de postgres. No hay
  datos de producción.
