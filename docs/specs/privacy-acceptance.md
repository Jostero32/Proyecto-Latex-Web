# Aviso y aceptación de tratamiento de datos

Objetivo: aviso público con responsable ARCM Solutions y contacto jona16lozada@gmail.com,
aceptación explícita y versionada para cuentas con Google y contraseña, y botón reconocible de Google.

Diseño: una pantalla común después de autenticar y antes de usar proyectos; casilla desmarcada,
leer aviso y salir sin aceptar. No se repite mientras siga vigente la misma versión. Historial en
privacy_acceptances (usuario, versión, fecha del servidor; único por usuario/versión). API autenticada
para aceptar, con Origin/CSRF, accepted===true y versión vigente; no se guarda IP adicional.
API de proyectos y WebSocket también bloquean hasta aceptar, incluidas sesiones existentes.
Documento compartido y versionado para que el texto público corresponda al registro persistido.

1. Contrato, aviso factual, migración y persistencia idempotente de aceptación.
2. API/WS y pantalla pública/común; conservar el destino de invitaciones y el acceso a logout.
3. Logo oficial local y botón Google; pruebas contra bypass HTTP/WS, versión antigua, rechazo,
   ambos métodos, persistencia y repetición. Tipos, lint, build y suite completa antes de push develop.

El aviso explica los datos de cuenta, proyectos, colaboración, sesiones, Google y SMTP; no promete
retenciones, ubicaciones, proveedores adicionales o cumplimiento legal que no se hayan confirmado.
La aceptación habilita el servicio; las operaciones necesarias para autenticar ya han ocurrido.
