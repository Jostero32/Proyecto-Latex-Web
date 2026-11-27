# Verificación de Google e invitaciones — develop

Implementación: OAuth/OIDC con biblioteca oficial, PKCE S256, state de un uso en Redis (600 s),
nonce y cookie temporal firmada HttpOnly/Secure/SameSite=Lax. Rotación de sesión al completar.
Validación del ID token en backend; no se guarda refresh token ni se expone client secret al frontend.
La identidad persistida usa subject único y el último correo verificado por Google. No se fusionan
cuentas por email; una cuenta local requiere vinculación desde su sesión y correo coincidente.

Invitaciones: dueño mediante assertProjectAccess(manage), límite de diez solicitudes por cuenta cada
quince minutos, token aleatorio de 32 bytes almacenado como SHA256, destinatario inmutable y
vencimiento de siete días por defecto (1–365). SMTP autenticado con TLS obligatorio. La invitación
permanece inactiva hasta confirmar envío. Los errores SMTP no exponen credenciales ni dejan un
nuevo token activo. Abrir el enlace no concede membresía. Preview y aceptación verifican correo de
cuenta y correo Google; la aceptación bloquea la fila y consume el enlace en la misma transacción.
El backend ignora un correo inventado en el cuerpo de aceptación. Los enlaces libres previos se
mantienen identificados; la interfaz crea exclusivamente invitaciones por correo.

## Validación

- Servidor: 74 pruebas, incluidas integración HTTP, PostgreSQL migrado, Redis y MinIO reales aislados.
- Shared: 188 pruebas; compiler: 67; web: 8.
- Tipos de todos los paquetes, lint, build web y validación de Docker Compose.
- Casos nuevos: state/cookie de otro navegador, cookie manipulada, caducidad, replay, cancelación,
  PKCE, validación del proveedor, retorno interno, conflicto/vinculación de cuentas, sesión local,
  correo incorrecto, email local sin verificar, nueva sesión Google, aceptación concurrente (solo una
  gana), reutilización tras retirar al miembro, revocación, vencimiento, permisos de dueño/editor y
  fallo SMTP sin fuga de secretos. Redis comprueba consumo atómico y TTL; SMTP se simula, sin correos reales.
- Regresión: login/logout, CSRF, permisos, colaboración, sesiones revocadas, almacenamiento,
  compilación y cola real. Las migraciones se aplicaron sobre la base temporal, no sobre producción.

Los servicios de prueba usaron un proyecto Compose separado, almacenamiento temporal y ninguna
base, cola, bucket o volumen de producción. La ejecución inicial a través de túneles SSH superó
límites por latencia; la comprobación final corre junto a los servicios en la misma red temporal.
Se retiraron metadatos AppleDouble de la copia de pruebas, sin cambiar los tests para ocultar errores.

## Revisión de seguridad y límites

Revisión manual de autenticación, CSRF, vinculación, permisos, replay, concurrencia, exposición de
secretos, destinatario y envío. No se identificaron hallazgos críticos/altos en el alcance revisado.
Las cookies de sesión mantienen tokens opacos y su hash en base de datos. La CSP y las guardas de
Host/Origin permanecen activas. Los logs de API omiten query strings OAuth y tokens de compartir.

No se ha completado consentimiento real con Google ni entrega real de correo: faltan las credenciales
del usuario y la configuración del cliente en Google Cloud. Los tests usan identidades simuladas
solo mediante dependencias inyectadas; no existe una ruta de producción que las acepte del cliente.
No se ejecutó una nueva auditoría ZAP/Burp del despliegue Google porque esta rama aún no está
activada en producción. Tampoco se ejecutaron compilaciones TeX reales: este cambio no toca el worker.

Configuración y despliegue: README y .env.example. No se incluye ningún secreto ni se mezcla develop
con main. Antes de activar, guardar credenciales en .env y autorizar exactamente
https://pliego.duckdns.org/api/auth/google/callback en el cliente OAuth web de Google.
