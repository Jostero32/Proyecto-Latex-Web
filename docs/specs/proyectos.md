# Spec: proyectos, archivos, compilación de proyectos y permisos (bloque B)

## 1. Objetivo
Que cada usuario tenga proyectos LaTeX guardados (archivos en MinIO), los compile sin volver a subirlos
y los comparta con roles. Cierra el núcleo del backend sobre el que se montan colaboración y frontend.

## 2. Alcance
**Incluye**
- CRUD de proyectos y de sus archivos (subir, bajar, reemplazar, renombrar o mover, borrar), con los
  binarios en MinIO y los metadatos en Postgres.
- Importar un proyecto desde zip y exportarlo como zip.
- `POST /projects/:id/compile`, y que `/compilations` exija sesión y solo deje ver resultados a quien
  corresponde (cierra el riesgo "acceso por uuid" de la spec de compilación).
- Roles dueño, editor y lector; enlaces para compartir (con rol y vencimiento, revocables).

**No incluye**: edición colaborativa en tiempo real (bloque C: el contenido se guarda entero con `PUT`),
carpetas vacías (las carpetas se derivan de las rutas), papelera, historial, cuotas por usuario
(backlog), invitaciones por email.

## 3. Diseño
**Modelo (Prisma)**

| Modelo | Campos clave |
|---|---|
| `Project` | `id`, `name`, `mainFile` (`main.tex`), `engine` (`pdflatex`), `createdAt`, `updatedAt` |
| `Membership` | `projectId`, `userId`, `role` (`owner` \| `editor` \| `viewer`); único `(projectId, userId)` |
| `File` | `id`, `projectId`, `path` (normalizado), `pathKey` (NFC + minúsculas, único por proyecto), `size`, `updatedAt` |
| `ShareLink` | `id`, `projectId`, `tokenHash` (sha256), `role` (`editor` \| `viewer`), `createdBy`, `expiresAt?`, `revokedAt?` |
| `Compilation` | `id` (el uuid de la compilación), `userId`, `projectId?`, `createdAt` |

- **Objetos en MinIO:** `projects/<projectId>/files/<fileId>`, en un bucket `S3_BUCKET` que el server crea al
  arrancar. La base es la fuente de verdad: primero se escribe el objeto y después la fila; al borrar,
  primero la fila y después el objeto. Los objetos huérfanos quedan para un barrido (backlog).
- **Rutas:** se validan con `normalizeProjectPath`, `isIgnoredPath` y `findPathCollision` (los mismos de la
  compilación), contra `pathKey` en la base.
- **Autorización:** una sola función, `assertProjectAccess(userId, projectId, action)`, que responde 404 si
  el usuario no es miembro (no revela que el proyecto existe) y 403 si su rol no alcanza:

  | Acción | lector | editor | dueño |
  |---|---|---|---|
  | ver el proyecto y los archivos, exportar, compilar y ver el PDF | ✓ | ✓ | ✓ |
  | escribir archivos, cambiar `mainFile` y `engine` | | ✓ | ✓ |
  | renombrar o borrar el proyecto, gestionar miembros y enlaces | | | ✓ |

**Endpoints** (todos con `requireUser`, errores `{ error, message }`)
- **Proyectos:**
  - `POST /projects {name}` crea el proyecto, la membresía de dueño y un `main.tex` de plantilla;
  - `GET /projects` lista los míos, con mi rol;
  - `GET`, `PATCH` y `DELETE /projects/:id`.
- **Archivos:**
  - `GET /projects/:id/files` devuelve el árbol plano: `{id, path, size, updatedAt}[]`;
  - `POST /projects/:id/files` sube en multipart, con el mismo formato y los mismos límites que `/compilations`, y crea o reemplaza por ruta;
  - `GET /projects/:id/files/:fileId` descarga el contenido (`nosniff`, `attachment`);
  - `PUT` reemplaza el contenido (cuerpo crudo), `PATCH {path}` renombra o mueve, y `DELETE` borra.
- **Zip:**
  - `POST /projects/import` crea un proyecto desde un zip;
  - `GET /projects/:id/export` devuelve el zip en streaming.
- **Compilación:**
  - `POST /projects/:id/compile` copia los archivos de MinIO a `<root>/<id>/input` y encola, usando el mismo worker sin cambios;
  - `GET /compilations/:id[/pdf|/log]` exige ser quien la creó o miembro de su proyecto. Si no, 404;
  - `POST /compilations` (multipart) sigue funcionando, pero ahora requiere sesión.
- **Miembros y enlaces** (solo el dueño):
  - `GET`, `PATCH {role}` y `DELETE /projects/:id/members/:userId`. El dueño no se quita ni se degrada a sí mismo;
  - `POST`, `GET` y `DELETE /projects/:id/share-links`. La respuesta del POST trae el token **una sola vez**;
  - `POST /share/:token/join`, con sesión: pasa a ser miembro con el rol del enlace, y si ya era miembro, se queda con el rol más alto.

**Zip seguro (import):** `yauzl` en streaming, con estas reglas:
- topes de entradas (`COMPILE_MAX_UPLOAD_FILES`), de bytes por archivo y de bytes totales, contando los
  bytes **reales** descomprimidos y no el tamaño declarado, contra las bombas de descompresión;
- rechazo de symlinks (atributos externos), rutas inválidas y colisiones;
- se ignoran `__MACOSX/`, los archivos ocultos y `latexmkrc`.

Export con `yazl`.

**Dependencias nuevas:**
- `@aws-sdk/client-s3`: cliente S3 estándar. Verificado contra `pgsty/minio` (bucket y put, get, list y delete).
- `yauzl` y `yazl`: zip en streaming, una dependencia cada una. Verificado el viaje de ida y vuelta y la
  lectura de los atributos.

**Config:** `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `PROJECT_MAX_BYTES` (200 MB) y
`PROJECT_MAX_FILES` (500). En compose, el server usa `http://minio:9000`.

## 4. Archivos
- `apps/server/prisma/schema.prisma` y una migración nueva
- `apps/server/src/lib/object-storage.ts` (S3: put, get stream, delete, delete por prefijo, ensureBucket)
- `apps/server/src/features/projects/`: `index.ts`, `routes.ts`, `service.ts`, `access.ts`
  (`assertProjectAccess`), `files.ts`, `zip.ts`, `sharing.ts` y `compile.ts`
- `apps/server/src/features/compilations/routes.ts` (sesión y dueño o miembro)
- `apps/server/test/integration/projects-*.test.ts` (Postgres, MinIO y Redis reales)
- `.claude/skills/probar-compilacion/probar.mjs` (registrarse o iniciar sesión antes de compilar)
- `config.ts`, `app.ts`, `index.ts`, `docker-compose.yml`, `.env.example`, `docs/specs/compilacion.md`

## 5. Pasos
1. **Proyectos y archivos:**
   - modelos, migración, `object-storage` y `ensureBucket`;
   - CRUD de proyectos y archivos, e import y export de zip;
   - `assertProjectAccess`, en este paso con el rol dueño;
   - tests de integración: CRUD, el viaje de ida y vuelta del zip y zips maliciosos (bomba, symlink, `../`).
2. **Compilación de proyectos y acceso a `/compilations`:**
   - modelo `Compilation`, `POST /projects/:id/compile` y la restricción por dueño o miembro;
   - la skill `probar-compilacion` con login;
   - un test de punta a punta: crear el proyecto, subir un fixture, compilar y bajar el PDF, y que otro usuario reciba 404.
3. **Roles y compartir:**
   - editor y lector aplicados en todas las rutas, miembros y enlaces;
   - tests de la matriz de permisos;
   - compose y documentación.

Al final: verificación en vivo en el stack y `revisor-seguridad`.

## 6. Criterios de aceptación
- [ ] Crear un proyecto, subir los 6 fixtures (como zip y por multipart), compilarlos con
      `POST /projects/:id/compile` y bajar el PDF: los 6 dan `success`.
- [ ] Un usuario que no es miembro recibe 404 en el proyecto, sus archivos, su compilación, el PDF y el log.
- [ ] Un lector puede ver, exportar y compilar, pero recibe 403 al escribir. Un editor no puede gestionar
      miembros ni borrar el proyecto.
- [ ] Un enlace de compartir agrega al miembro con su rol; si está revocado o vencido, 404.
- [ ] Un zip con `../`, con un symlink, de más de N entradas o que se infla por encima del tope se rechaza
      sin escribir nada.
- [ ] `POST /compilations` sin sesión da 401.
- [ ] `pnpm test`, `typecheck`, `lint` y `test:integration` pasan, y `/probar-compilacion` da 6/6.

## 7. Riesgos
- **Consistencia entre MinIO y Postgres:** un fallo entre los dos pasos deja un objeto huérfano, nunca
  una fila sin objeto (por el orden de escritura). El barrido de huérfanos va al backlog.
- **Zips maliciosos:** el tope se aplica sobre los bytes descomprimidos reales, que se cuentan mientras
  se lee; nunca sobre el tamaño que declara el zip.
- **Token de los enlaces:** se guarda su sha256, como en las sesiones. Quien tenga el enlace se une: por
  eso los enlaces vencen y se pueden revocar.
- **Copia de MinIO a disco al compilar:** para un proyecto de hasta 200 MB es aceptable. Leer los
  archivos directamente desde el worker queda para más adelante.
