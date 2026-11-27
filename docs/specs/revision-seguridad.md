# Revisión de seguridad para ZAP y Burp

## Objetivo y alcance
Revisar cabeceras, sesiones y permisos en `https://pliego.duckdns.org/`, desplegado en Oracle Cloud.
HTTPS termina en Nginx Proxy Manager; no se instala otro terminador TLS en el proyecto.

## Cambios
1. Cabeceras de seguridad en API (incluidos errores) y frontend servido por `vite preview`. Extraer
   el script inicial del tema para restringir JavaScript a archivos del mismo origen. Conservar los
   estilos dinámicos necesarios para CodeMirror mediante nonce por respuesta HTML. La presencia usa
   clases y una paleta cerrada, sin `unsafe-hashes`; servir las fuentes localmente con sus licencias OFL.
2. Revalidar la sesión de colaboración antes de procesar mensajes: no aceptar modificaciones tras
   logout o caducidad. Pasar `ALLOWED_HOSTS` desde Compose para el dominio del despliegue.
3. Aplicar HSTS solo al host de Pliego, sin preload ni subdominios; responder correctamente a los
   metadatos y archivos inexistentes; separar caché de recursos públicos y contenido privado.
4. Verificar con pruebas y ZAP sin sesión y autenticado, usando únicamente datos desechables para
   las pruebas de permisos, colaboración y compilación. Documentar el alcance real y las limitaciones.

## Criterios y límites
Los permisos se resuelven en el servidor a partir de la sesión, nunca de un rol enviado por el cliente.
Un lector no puede escribir mediante REST ni mensajes de sincronización manipulados. Una sesión
revocada no puede enviar nuevas modificaciones por una conexión abierta.

Los resultados del escáner deben conservarse completos, sin ocultar ni cambiar la severidad de alertas.
No se garantiza ausencia de vulnerabilidades por el color de las banderas. La CSP usa un nonce por
HTML, sin `unsafe-inline`, `unsafe-hashes` ni `unsafe-eval`. Verificar TLS, HSTS y cookies Secure desde
Internet. Confiar en la CA de Burp permite inspeccionar HTTPS.
