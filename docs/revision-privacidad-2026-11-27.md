# Verificación de privacidad y botón Google

Rama develop. Aviso público `/privacidad`; responsable y contacto indicados por el usuario:
ARCM Solutions, jona16lozada@gmail.com. Pantalla común `/privacidad/aceptar` después de autenticar
con Google o contraseña y antes de usar proyectos. Casilla desmarcada, aceptación expresa y salida
sin aceptar. Login muestra el enlace al aviso antes de autenticar.

Persistencia en privacy_acceptances: usuario, versión, fecha del servidor, clave única compuesta,
FK con borrado en cascada. Se conserva historial; repetir o aceptar concurrentemente no cambia la
fecha original. Las cuentas existentes permanecen sin aceptación hasta actuar expresamente.
No se añade IP ni agente al registro de aceptación. Cambiar la versión exige nueva aceptación.

Las rutas privadas de proyectos y el upgrade/mensajes WebSocket verifican la aceptación en backend.
/auth/me, el aviso público y logout siguen disponibles. El endpoint rechaza accepted ausente, false,
"true" o 1; exige booleano true y versión vigente. Origin y sesión son obligatorios; no se confía en
userId ni fecha enviados por el cliente. Google OIDC no constituye aceptación del aviso de Pliego.

Validación: servidor 78 tests (14 archivos), shared 188, compiler 67, web 8: 341 tests correctos.
Tipos, lint y build web correctos. PostgreSQL migrado, Redis y MinIO temporales, en proyecto Compose
sin puertos publicados ni acceso a datos de producción. Regresión de auth, invitaciones, colaboración,
permisos, compilaciones y almacenamiento. Revisión manual de los controles de sesión, CSRF, versión,
concurrencia y bypass; sin hallazgos críticos/altos identificados en este alcance.

Verificación visual con vista previa local y backend ficticio fuera del repositorio: logo Google visible,
login por email redirige al aviso, texto y contacto visibles, casilla inicialmente vacía, botón deshabilitado
hasta marcarla y salida sin aceptar regresa al login. No se aceptó el aviso en nombre del usuario ni se
usaron datos personales reales en las pruebas de navegador. Los tests de API verificaron persistencia.
Logo descargado del recurso oficial Google y servido localmente, sin SDK ni relajación de CSP.

Límites: no se desplegó esta versión sobre producción ni se ejecutó consentimiento real Google o
envío SMTP. El aviso describe el tratamiento técnico; el responsable debe revisar/completar la
información operativa/legal aplicable, incluidos plazos, infraestructura y transferencias. Implementar
una casilla no prueba cumplimiento jurídico integral. Fuentes consultadas: guía de marca Google y
SPDP sobre consentimiento, enlazadas en README. No se inventaron direcciones, plazos ni garantías.
