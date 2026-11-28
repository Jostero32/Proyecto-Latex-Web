# Revisión de peticiones manipuladas y bitácora

Alcance: código de `develop`, pruebas automatizadas contra PostgreSQL/MinIO/Redis desechables.
El renombrado de un proyecto por su dueño sigue permitido, incluso si la petición se modifica en
Burp. Las pruebas de Burp descritas por el usuario son antecedentes; esta revisión no ejecuta Burp
ni acredita por sí sola el estado del despliegue público.

## Controles

| Control | Estado y comprobación |
| --- | --- |
| Actor HTTP y WebSocket | Proviene de sesión, no de `userId`, `role`, `ownerId` ni `privacy.accepted` en JSON. Regresiones HTTP de asignación masiva. |
| Permisos HTTP | Se mantiene `assertProjectAccess` en cada acción; lector no escribe y ajeno recibe 404. El dueño conserva sus operaciones autorizadas. |
| Permisos WebSocket | Se consulta membresía y rol en PostgreSQL antes de cada mensaje, además de sesión y aceptación del aviso. Bajada de editor a lector y eliminación directa en BD con conexión abierta: no se aplica el texto enviado. |
| CSRF | Origin obligatorio con cookie y validado contra orígenes permitidos; Referer presente también debe ser válido y permitido. Referer no sustituye Origin. Sigue SameSite=Lax. |
| Campos de entrada | Esquemas JSON de proyectos, archivos y compartir con `additionalProperties: false`; Fastify elimina extras. PATCH sin campos editables devuelve 400. No se bloquea el cambio legítimo de roles que hace el dueño. |
| Invitación por email | Token solo por email, sin token en JSON de creación ni en la bitácora. Se conserva la validación de destinatario Google, vencimiento, revocación y uso único. Los enlaces libres anteriores tienen otro contrato y sí entregan token al crearse. |
| Límites | Se conservan los límites existentes de login e invitaciones, archivos, documentos y mensajes WebSocket. No se añade HMAC ni un secreto al JavaScript para intentar detectar Burp. |

## Bitácora

La migración `0006_bitacora_mutaciones.sql` crea `mutation_audit`. Las mutaciones HTTP de las rutas
protegidas de proyectos/archivos/compartir/compilación registran intención antes del handler y
resultado antes de entregar su respuesta. Se guardan actor de sesión, UUID del proyecto/recurso,
método y plantilla de ruta, fechas, resultado, estado HTTP y metadatos antes/después. Nunca se usa
la URL cruda con tokens ni se copia el cuerpo HTTP. Crear/importar resuelve el UUID desde la
respuesta del servidor; aceptar una invitación resuelve su proyecto mediante el hash del token.

Los metadatos incluyen nombre/motor/principal del proyecto y, cuando corresponde, archivo, rol del
miembro o estado del enlace. Texto por REST: hash SHA-256 antes/después. Operaciones sobre el árbol:
primeros 100 archivos ordenados por UUID y marca `filesTruncated` si hay más. Los snapshots son
observaciones antes/después, no un aislamiento transaccional frente a otros editores simultáneos.

Los updates Yjs nuevos registran intención antes de aplicarse y resultado después del mensaje.
`onChange` identifica la conexión que realmente aplicó el update: hash del snapshot Yjs (incluye
borrados) y del update aplicado. Dos editores concurrentes conservan su propia atribución. Un frame
de escritura de lector no se aplica y queda denegado. Handshakes, retransmisiones sin cambios,
presencia y lecturas no crean eventos de mutación. No se almacena texto ni bytes de los updates.
Los hashes sirven para comparar estados; no son cifrado ni permiten reconstruir el documento.

Consulta: `GET /api/projects/:id/audit-events?limit=50`, solo con sesión del dueño y aceptación
vigente. Devuelve los últimos 50 por defecto y como máximo 100. Está documentada en OpenAPI. No hay
API para cambiar o borrar eventos. La tabla no tiene FK en cascada: borrar proyecto o cuenta no
borra su historial; después de borrar el proyecto su consulta requiere acceso administrativo a BD.
No se promete inmutabilidad frente al administrador de PostgreSQL. El responsable debe gestionar
la retención y las solicitudes de privacidad: no se configura borrado automático de estos registros.
El aviso `2026-11-27.2` explica estos registros y su consulta por el dueño; requiere nueva aceptación.

Resultados: `pending`, `applied`, `unchanged`, `denied` o `failed`. Si no se puede guardar la intención,
HTTP devuelve 503 sin ejecutar el handler y WebSocket no aplica el update. Si falla la finalización,
queda `pending`: HTTP devuelve 503 indicando comprobar estado; WebSocket cierra la conexión. El
cambio puede haberse aplicado. No se afirma rollback ni atomicidad distribuida entre DB, S3, SMTP y
Yjs. `applied` en colaboración significa aplicado al documento en memoria; la persistencia de Yjs
mantiene su guardado diferido habitual. Un fallo de proceso antes de guardarlo sigue siendo posible.
La bitácora no sustituye respaldos, recuperación de versiones ni monitorización de incidentes.

## Verificación y límites

Pruebas del servidor: permisos existentes, campos adicionales, CSRF, roles cambiados desde otra
instancia, lector con update manipulado, atribución concurrente, borrado de texto, consulta de
historial, secreto ausente de registros, supervivencia a borrado del proyecto y fallos de bitácora.
Resultado: **348 pruebas aprobadas** (server 85, shared 188, compiler 67 y web 8).
Tipos de los cuatro paquetes, lint y build de web aprobados. Las herramientas locales se ejecutaron
directamente desde `node_modules` y la suite del servidor mediante pnpm en el runner desechable.
No se ejecuta compilación real con TeX Live ni auditoría activa contra producción en esta revisión.

La instrucción `/security-review` del repositorio no está disponible como comando o skill en esta
sesión. Se hizo revisión manual del diff: identidad desde sesión, accesos a BD, serialización de
respuestas, datos excluidos del registro y modos de fallo descritos arriba. No se declara ausencia
de vulnerabilidades ni protección frente a una cuenta propietaria comprometida. El volumen y la
retención de la nueva bitácora se registran como seguimiento de prioridad media en `docs/backlog.md`;
se requiere monitorizar su crecimiento y acordar límites para un uso mayor.

## Actualizar el servidor

Con respaldo habitual y un checkout Git de esta aplicación (no una carpeta copiada sin `.git`):

```bash
git fetch origin
git switch develop
git pull --ff-only origin develop
sudo docker compose up -d --build server web
```

Se aplica la migración al arrancar. Reconstruir ambos servicios mantiene el mismo aviso de
privacidad en API y frontend. Conservar `.env`, nombre Compose y volúmenes; este cambio no requiere
nuevos puertos ni cambios en Nginx. El push no despliega por sí solo en Oracle.
