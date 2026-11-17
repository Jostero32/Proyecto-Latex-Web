# Backlog

Hallazgos medios y bajos, y cosas fuera de alcance de cada spec. Lo crítico y alto se corrige en el
momento (CLAUDE.md, "Forma de trabajo"). Ordenado por prioridad dentro de cada sección.

## Seguridad y robustez
| Prioridad | Origen | Ítem |
|---|---|---|
| media | auth | **Rate limit por IP detrás de un proxy:** en compose todas las peticiones llegan con la IP del gateway de Docker, así que el límite "por IP" es global (10 fallos bloquean el login de todos durante 15 min). En producción configurar `trustProxy` con la IP del proxy (spec `despliegue`). |
| media | compilación | **Socket de Docker en el worker** (= root sobre el host): para producción, Docker sin root o gVisor (spec `despliegue`). |
| media | auth | **El rate limit falla abierto** (`skipOnError: true`): con Redis caído, login y registro quedan sin límite. Opción: fallar cerrado o usar un limitador en memoria como respaldo. |
| media | auth | **Bloqueo dirigido:** con el límite por email, 10 intentos fallidos dejan a la víctima sin login 15 min. Opción: contar por email solo los fallos y con un tope más alto. |
| baja | auth | Cookie `sid` sin prefijo `__Host-` (cookie tossing desde un subdominio): usar `__Host-sid` cuando `COOKIE_SECURE=true`. |
| baja | auth | `web` comparte la red `default` con `postgres`, y `server` usa el mismo usuario de base (con DDL) que `migrate`: red propia para postgres y un rol solo DML para el server. |
| baja | compilación | biber usa 49 de sus 83 bibliotecas nativas precalentadas; una función rara que necesite otra falla con "Read-only file system". |
| media | proyectos | **Subidas en memoria:** `POST /files` y la importación de zip leen todo en memoria (hasta `PROJECT_MAX_BYTES` por petición). Con varias a la vez el server puede quedarse sin RAM: limitar las subidas concurrentes o pasar a archivos temporales. |
| baja | proyectos | **Topes con carreras:** dos subidas simultáneas al mismo proyecto pueden pasar juntas el tope de bytes o de archivos (se calcula antes de escribir, sin bloqueo). |
| baja | proyectos | **Objetos huérfanos en MinIO** si falla la base después de subir un binario (orden deliberado: nunca filas sin objeto). Falta un barrido. |
| baja | auth | El rate limit guarda claves con el prefijo `latexweb-ratelimit-undefinedundefined-…` (cosmético, del plugin con `app.rateLimit()`). |

## Fuera de alcance (pendiente de spec)
- **proyectos:** renombrar o mover una carpeta entera en una sola operación (hoy, un PATCH por archivo);
  carpetas vacías; transferir la propiedad; salir de un proyecto compartido.
- **auth:** verificación de email, recuperación de contraseña, OAuth, 2FA, "cerrar todas las sesiones",
  borrar la cuenta.
- **compilación:** publicar `output.blg` (errores de biber) → `errores-del-log`.
