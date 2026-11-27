# Invitaciones por correo

Objetivo: el dueño envía una invitación con rol y vencimiento. Solo la cuenta cuyo correo fue
verificado con Google y coincide exactamente con el destinatario puede ver y aceptar el proyecto,
aunque el enlace se abra en otro navegador. Las cuentas locales deben vincular primero Google.

Diseño: reutilizar share_links con recipient_email y accepted_at; null conserva enlaces anteriores.
Token aleatorio, solo hash en BD, aceptación única dentro de una transacción con bloqueo de fila.
El backend comprueba destinatario; nunca confía en email enviado por el navegador. Guardar el email
verificado de Google además del subject estable. No fusionar cuentas automáticamente por email.

1. Persistencia y servicio: migraciones aditivas, validación antes de preview/join, caducidad y revocación.
2. SMTP: Nodemailer para STARTTLS/SSL autenticado, PUBLIC_URL canónica; límite por dueño, invalidar
   invitación ante fallo de envío; activar solo tras confirmación SMTP. No incluir tokens en respuestas ni logs. Sin SMTP, no ofrecer envío.
3. Interfaz: correo, rol, vencimiento, confirmación de envío; recuperación con la cuenta Google correcta.
4. Verificar acceso indebido, cuenta sin verificar, reenvío, repetición, vencimiento, fallo SMTP y permisos;
   ejecutar tests, tipos, lint y build antes de subir develop.

Riesgos: entrega real depende de SMTP y credenciales; no enviar correos reales en tests. Los enlaces
libres previos mantienen su comportamiento y se identifican como tales; la UI solo crea invitaciones.
