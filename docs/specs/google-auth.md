# Inicio de sesión con Google

## Objetivo
Añadir Google a Pliego en la rama `develop`, manteniendo las sesiones existentes y el login con
contraseña. Callback de producción: `https://pliego.duckdns.org/api/auth/google/callback`.

## Diseño
1. OAuth/OIDC con código de autorización, PKCE S256, state de un solo uso, cookie HttpOnly que
   vincula el navegador y nonce. Redis conserva la transacción durante diez minutos. La biblioteca
   oficial `google-auth-library` verifica la firma, emisor, audiencia y caducidad del ID token;
   además se validan nonce, email verificado y sujeto. Solo se solicitan openid, email y profile.
2. `users.google_subject` identifica la cuenta por `sub`, con índice único. La contraseña puede
   ser nula para cuentas de Google. No se enlazan cuentas automáticamente por email: una cuenta
   existente se vincula desde una sesión ya autenticada y debe tener el mismo email verificado.
3. Botón «Continuar con Google» cuando el servidor tiene configuración completa. El menú de cuenta
   permite vincular Google. Se vuelve a un destino interno validado y se rota la sesión. Secretos,
   códigos y tokens no se exponen en el frontend ni en los logs.
4. Migración, Compose, `.env.example`, documentación y pruebas de validación, state, replay,
   cancelación, conflictos de cuenta y sesiones. Publicación en `develop`, sin mezclar en `main`.

## Configuración y criterios
Google Cloud debe autorizar exactamente el callback y el origen `https://pliego.duckdns.org`.
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` y `PUBLIC_URL` viven en `.env` del servidor,
nunca en Git ni en variables VITE_. Sin credenciales, el login actual sigue funcionando.
La CSP se conserva: no se añade un SDK externo al navegador.

Las pruebas usan un proveedor simulado para fallos y protocolos; la prueba real de consentimiento
depende de credenciales válidas y de que el usuario complete el inicio de sesión de Google.
