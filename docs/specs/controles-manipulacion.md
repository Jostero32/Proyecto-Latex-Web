# Controles del servidor ante peticiones manipuladas

Objetivo: reforzar autorización y trazabilidad; el dueño conserva las operaciones que le corresponden.
Burp puede modificar cualquier petición del cliente y no se intenta detectarlo ni impedirlo desde JS.

1. Actualizar rol y membresía desde PostgreSQL antes de cada mensaje de colaboración, además de sesión
   y privacidad. Listas de campos permitidos en cuerpos JSON y rechazo de PATCH vacíos; Origin sigue
   siendo obligatorio con cookie y se comprueba también Referer si viene. Regresiones de asignación
   masiva, identidad inventada, roles modificados directamente en BD y lector con frames editados.
2. Bitácora persistente de mutaciones de proyectos por HTTP y de updates Yjs por WebSocket: actor de
   sesión, recurso, operación, fecha, antes/después de metadatos, resultado. Registrar intención antes
   de ejecutar y finalizar después: ante interrupción queda pendiente, sin atribuir éxito. No guardar
   contenido completo, contraseñas, cookies, código OAuth, tokens de invitación ni cuerpos arbitrarios.
   Lectura de últimos eventos solo por el dueño, con límite. Preservar eventos al borrar proyecto.
3. Pruebas con infraestructura desechable separada de producción, tipos y lint; commits españoles y
   push a develop. Revisar seguridad y documentar cobertura/limitaciones. Sin despliegue automático.

CSRF token adicional no es necesario para este alcance: ya se exige Origin exacto con sesión y
SameSite=Lax. Login e invitaciones ya tienen límites. Las invitaciones por email no devuelven token;
los enlaces libres anteriores mantienen su contrato y deben distinguirse en documentación y pruebas.
La bitácora no es un sistema de recuperación, ni inmutable frente a un administrador de PostgreSQL.
Las operaciones y su registro final no son una transacción distribuida con S3/SMTP/Yjs: un evento
pendiente requiere comprobar el estado real. No se promete bloqueo de peticiones autorizadas.
