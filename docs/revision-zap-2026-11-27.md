# Revisión de Pliego con ZAP — 26 y 27 de noviembre de 2026

Destino: https://pliego.duckdns.org/. Cambios aplicados en `/home/ubuntu/Proyectos/seguridad`,
Oracle Cloud. HTTPS termina en Nginx Proxy Manager. Se conservan las reglas de Host y Origin.

## Resultado

ZAP 2.17.0, sin filtros de alertas ni cambios de severidad:

| Riesgo | Antes: rutas públicas | Después: rutas públicas y autenticadas |
| --- | ---: | ---: |
| Alto | 0 | 0 |
| Medio | 5 | 0 |
| Bajo | 11 | 0 |
| Informativo | 10 | 5 |

Los números son ocurrencias en respuestas analizadas, no cantidades de vulnerabilidades diferentes.
La cobertura final incluye login y datos autenticados que no estaban en el recorrido público inicial.

## Correcciones

| Hallazgo | Causa | Corrección y evidencia |
| --- | --- | --- |
| CSP: `style-src unsafe-hashes` (10055) | La presencia de y-codemirror.next insertaba atributos `style`. | La sincronización y el undo siguen usando y-codemirror.next; los cursores y selecciones se dibujan con `presence.ts`, clases y una paleta cerrada. No se interpolan colores remotos en CSS. La CSP no contiene `unsafe-hashes`, `unsafe-inline` ni `unsafe-eval`. |
| HSTS ausente (10035) | El host del proxy no emitía la cabecera. | Configuración avanzada persistente del host 4, exclusivamente `pliego.duckdns.org`. `Strict-Transport-Security: max-age=31536000`, sin preload ni subdominios. Usa el filtro de cabeceras de OpenResty para cubrir errores y evitar el problema de herencia de `add_header`. Se validó y recargó Nginx; los archivos de los otros hosts conservaron sus hashes. |
| Metadatos tratados como SPA | El fallback devolvía `index.html` para recursos inexistentes. | `robots.txt` devuelve texto válido; `sitemap.xml`, no publicado por esta app privada, responde 404. Otros archivos inexistentes responden 404 con la CSP completa. |
| Reexaminar caché (10015) | Políticas genéricas que ZAP pedía revisar. | HTML con nonce, metadatos y auth: `no-cache, no-store, must-revalidate`. La API privada añade `private`. Los assets públicos con hash usan `public, max-age=31536000, immutable`; fuentes y archivos públicos sin hash tienen caché corta. El aviso ya no aparece en el recorrido final. |

Las hojas de CodeMirror usan un nonce aleatorio por respuesta HTML. Se comprobó que la cabecera y
el `<meta>` coinciden y que dos respuestas consecutivas reciben nonces distintos, también al entrar
por `/index.html` o su variante codificada.

## Informativas restantes

| Regla | Ocurrencias | Interpretación |
| --- | ---: | --- |
| Modern Web Application (10109) | 2 | React es una aplicación web moderna. La documentación de ZAP indica que no requiere cambios; recomienda exploración compatible con estas aplicaciones. |
| Authentication Request Identified (10111) | 1 | Identifica la petición de login realizada durante la prueba. |
| Session Management Response Identified (10112) | 2 | Identifica la cookie de sesión de la respuesta de login. No se eliminó ni ofuscó el mecanismo de sesión para evitar la detección. |

Referencias: [Modern Web Application](https://www.zaproxy.org/docs/alerts/10109/),
[revisión de caché](https://www.zaproxy.org/docs/alerts/10015/),
[filtro de cabeceras de OpenResty](https://github.com/openresty/headers-more-nginx-module).

## Validación realizada

- TypeScript de los cuatro paquetes, ESLint, build local y builds Docker de web/API correctos.
- 8 pruebas de la web y 15 regresiones HTTP aisladas correctas, incluidas guardas, cabeceras y Swagger.
- En el navegador: registro y sesión HTTPS, creación de proyecto, edición sincronizada entre dos
  sesiones, cursores y selecciones remotas coloreados sin atributos `style`, recarga y persistencia.
  Sin errores ni avisos CSP en las consolas observadas.
- Compilación real y PDF renderizado, con descarga disponible. Otra compilación real y descarga
  autenticada de PDF, log y SyncTeX después del ajuste final de caché.
- 14 comprobaciones HTTP: cookie inventada, falta de sesión, usuario ajeno, lector que intenta
  escribir o elevar permisos, rol inválido, editor que intenta administrar, Origin ajeno, sesión
  cerrada y escritura autorizada. Todas devolvieron el resultado esperado.
- Mensajes WSS enviados con un cliente de protocolo: lector sin permiso de escritura rechazado,
  usuario ajeno sin acceso al documento y editor con sesión cerrada incapaz de modificar desde su
  conexión existente. No se persistieron los marcadores maliciosos de prueba.
- HTTPS público con certificado válido, HSTS en HTML, recursos y respuestas de error; una sola CSP
  por respuesta; caché diferenciada y nonces distintos.
- ZAP en sesión nueva, tráfico público y autenticado, sin ocultar alertas.

## Limpieza, respaldos y límites

Solo se usaron cuatro cuentas y dos proyectos desechables autorizados. Los proyectos se eliminaron
por la API. La limpieza de cuentas verifica sus IDs, el patrón de email de auditoría y que no tengan
otros proyectos antes de eliminarlas y revocar sus sesiones. No se borraron datos existentes ni volúmenes.

Respaldos de las fuentes e informes completos: `.audit-backups/zap-20261126/` en el proyecto remoto.
Respaldo específico del proxy: `/data/pliego-audit-20261126/` dentro de Nginx Proxy Manager. HSTS se
gestiona en la configuración avanzada de este host, sin activar el ajuste estándar de preload.

Configuración avanzada reproducible para ese host en Nginx Proxy Manager (OpenResty):

```nginx
set $pliego_hsts "";
if ($scheme = https) { set $pliego_hsts "max-age=31536000"; }
more_set_headers "Strict-Transport-Security: $pliego_hsts";
```

Esta configuración vive en el proxy, fuera del repositorio de la aplicación. Un `git pull` no la
elimina ni la aplica automáticamente a una instalación nueva.

La suite completa del backend no se pudo ejecutar localmente: Docker Desktop no estaba disponible.
Por ello se ejecutaron las regresiones HTTP sin infraestructura y las pruebas funcionales y de permisos
contra datos desechables del servidor. No se ejecutó en este cierre un escaneo de Burp ni un escaneo
activo general de ZAP. La cobertura de ZAP fue pasiva, acompañada de pruebas manuales de manipulación.

Este resultado corresponde a las rutas y funciones recorridas; no certifica ausencia de vulnerabilidades
ni audita otros servicios de Oracle. El puerto 55173 sigue publicado según la configuración solicitada
previamente; esta revisión se centró en el dominio HTTPS.
