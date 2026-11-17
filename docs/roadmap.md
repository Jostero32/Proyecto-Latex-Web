# Roadmap del backend

Specs pendientes del backend en orden de dependencia. Cada una se escribe con `/spec <nombre>` antes de
implementarla (CLAUDE.md). El alcance de cada ítem es orientativo: la spec lo define.

Estado: **0** en curso; el resto, pendiente.

## Orden

```
0. compilacion (pasos 6-9)
   ├── 1. ci
   ├── 2. errores-del-log
   └── 3. auth
        └── 4. proyectos-y-archivos
             ├── 5. compilar-proyecto ──┐
             └── 6. permisos-y-compartir┤
                                        ├── 7. colaboracion
                                        │     └── 8. historial
                                        └── 9. synctex
                                              10. limites-y-cuotas   (después de 5 y 6)
                                              11. despliegue         (al final)
```

## 0. compilacion — en curso
Terminar los pasos 6 a 9 de `docs/specs/compilacion.md`: el processor del worker, la API
`/compilations` (subida, estado, descargas) y la prueba de punta a punta con `/probar-compilacion` y
`revisor-seguridad`. Bloquea todo lo demás que compila.

## 1. ci — *nuevo, propuesto*
GitHub Actions: `pnpm install --frozen-lockfile`, `lint`, `typecheck` y `test` en cada PR. Además, un job
con Docker que construye la imagen (con caché) y corre `pnpm test:integration` con
`LATEXWEB_REQUIRE_DOCKER=1`. Es chico y protege a todo lo que viene, por eso va temprano.

## 2. errores-del-log — *adelantado*
Parsear el log de LaTeX en errores y advertencias con archivo, línea y mensaje (aprovechando
`-file-line-error`), e incluir `output.blg` para los errores de biber (hoy no se publica). Solo depende
de la compilación, así que puede hacerse en paralelo con auth.

## 3. auth
Prisma + Postgres (primer modelo y migraciones; esta spec monta la base de datos para todo el proyecto),
registro, login y logout, y sesiones en cookies httpOnly + `Secure` + `SameSite`. Incluye protección
**CSRF** (obligatoria con sesiones en cookie), hash de contraseñas con argon2 y rate limit en login. A
decidir en la spec: dónde viven las sesiones (Postgres o Redis), y si entran verificación de email y
recuperación de contraseña o van después.

## 4. proyectos-y-archivos
CRUD de proyectos, árbol de archivos (crear, renombrar, mover, borrar) y subida y descarga, con los
binarios en MinIO y los metadatos en Postgres. Importar y exportar zip, con protección contra bombas
de descompresión, symlinks y rutas (reusando `normalizeProjectPath`). Crea la tabla de **miembros del
proyecto** con solo el rol dueño y un único `assertProjectAccess(usuario, proyecto, acción)`, que
después usan 5, 6 y 7.

## 5. compilar-proyecto
Compilar desde un proyecto guardado en lugar de multipart: el worker lee los archivos de MinIO
(implementación de MinIO de la interfaz de workspace/storage de la spec de compilación) y los
artefactos se guardan asociados al proyecto. Solo los miembros ven el estado, el PDF y el log. Se
**retira o restringe** `POST /compilations` anónimo, que hoy permite compilar sin cuenta.

## 6. permisos-y-compartir — *adelantado, antes de colaboración*
Roles dueño, editor y lector sobre la tabla de miembros, invitaciones (por enlace con token de un solo
uso; el email puede ir después) y compartir por enlace de solo lectura o de edición, revocable. Va
antes de colaboración para que el WebSocket nazca con la distinción lector/editor
(`readOnly` en Hocuspocus) en lugar de agregarla después.

## 7. colaboracion
Autenticación y autorización en el manejador de upgrade de `/collab` (sesión + permiso sobre el
documento; ya marcado en `features/collab/websocket.ts`), persistencia de los documentos Yjs en Postgres y
sincronización Yjs ↔ archivos: lo que se compila tiene que ser el estado actual del documento
colaborativo, no una copia vieja en MinIO. Límites de tamaño de mensaje y de documento.

## 8. historial
Versiones de los archivos y del proyecto (snapshots de Yjs o del árbol en MinIO), ver una versión, diff
entre versiones y restaurar. Depende de colaboración porque las ediciones llegan por Yjs.

## 9. synctex
Compilar con `-synctex=1` (agregar la opción a la lista blanca de `latexweb-compile.sh` y a
`docker-args`), publicar `output.synctex.gz` y exponer la búsqueda en las dos direcciones (código → PDF
y PDF → código). Se puede hacer apenas esté la 5; es más útil cuando exista el visor en el frontend.

## 10. limites-y-cuotas — *nuevo, propuesto*
Rate limiting por usuario (la spec de compilación lo posterga "hasta que haya autenticación"),
compilaciones concurrentes por usuario, tamaño máximo de proyecto y de cuenta, y limpieza de artefactos
y proyectos borrados en MinIO. Va después de 5 y 6, cuando hay usuarios y proyectos que limitar.

## 11. despliegue — *nuevo, propuesto*
Dockerfiles de `server` y `compiler`, configuración de producción y cómo corre el worker con acceso a
Docker sin dar root sobre el host (Docker rootless o gVisor), un riesgo ya anotado en la spec de
compilación. Va al final, cuando el backend está completo.

## Cambios respecto de la lista inicial
- **Nuevos:** `ci` (temprano), `limites-y-cuotas` y `despliegue`.
- **Adelantados:** `errores-del-log` (no depende de auth) y `permisos-y-compartir` (antes de
  colaboración, para no rehacer la autorización del WebSocket).
- **Responsabilidades movidas:** la tabla de miembros y `assertProjectAccess` nacen en
  `proyectos-y-archivos`, para que `compilar-proyecto` pueda restringir el acceso sin esperar a los roles.
- **Dentro de `auth`:** CSRF y rate limit en login, que la lista inicial no mencionaba y son obligatorios
  con sesiones en cookie.
