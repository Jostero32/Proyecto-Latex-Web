# Frontend

## Objetivo
La web de latexweb: entrar, ver y crear proyectos, editar en vivo con otras personas, compilar, ver el
PDF y los errores, y compartir. El diseño de referencia es **Pliego** (lienzo de Claude Design y su
especificación, del 2026-11-17): sistema visual, pantallas en escritorio y celular, componentes y estados.

## Alcance
- Pantallas: entrada (entrar y crear cuenta), mis proyectos, editor, compartir, unirse con un enlace,
  ajustes del proyecto.
- Tema claro y oscuro con los mismos tokens; teclado y foco visible en todo; textos en español (voseo).
- Fuera: modo visual (spec `editor-visual.md`), historial, cuotas, invitaciones por email y recuperar la
  contraseña.

## Diseño
- **Tokens:** variables CSS (`--c-*`) para claro (`:root`) y oscuro (`[data-theme=dark]`), expuestas a
  Tailwind 4 con `@theme inline` (`bg-surface`, `text-muted`, `border-border-input`…). El tema se elige en
  el menú de la cuenta (claro, oscuro o el del sistema) y se recuerda en `localStorage`.
- **Tipografías** (Google Fonts): Instrument Sans (interfaz), Newsreader (títulos), JetBrains Mono
  (código, rutas y log) y STIX Two Text (la hoja de la entrada y los botones B e I).
- **Íconos:** trazos SVG propios en `components/Icon.tsx`, sin librería de íconos.
- **Rutas:** `/entrar`, `/` (mis proyectos), `/proyectos/:id` (editor), `/unirse/:token`.
- **Contratos:** los datos de ejemplo usan los tipos de `@latexweb/shared` (`ProjectSummary`,
  `ProjectFile`, `ProjectMember`, `ShareLink`, `Diagnostic`, `CompilationStatus`), para que conectar la
  API sea cambiar la fuente de datos y no los componentes.
- **Pistas de errores:** `lib/hints.ts` traduce los mensajes comunes del log a una pista en español. El
  mensaje original se muestra siempre, como texto.

## Pasos
1. **Interfaz con datos de ejemplo.** Todas las pantallas, diálogos y estados del diseño con React Router
   y Tailwind, sin llamar a la API. Las interacciones son locales (abrir diálogos, filtrar, plegar
   paneles, una compilación simulada). Los estados se ven con parámetros de la URL:
   - `/entrar?error=email-registrado|credenciales|intentos`
   - `/?estado=vacia|cargando|error`
   - `/proyectos/:id?vista=exito|errores|lector&aviso=permisos|sin-acceso|sin-conexion|doc-grande`
   - `/unirse/:token?estado=normal|sin-sesion|vencido|ya-miembro`

   El código se muestra resaltado pero todavía no se edita, y el PDF es una página de muestra.
2. **API:** auth, proyectos, archivos, compartir y unirse con TanStack Query. Vite hace de proxy de `/api`
   y `/collab` (un solo origen); el destino sale de `API_PROXY_TARGET` (en compose, `http://server:3000`).
   - `lib/api.ts`: `fetch` con la cookie de sesión; un error de la API llega como `ApiRequestError` con
     `status`, `code` (el de `{ error }`) y `retryAfter`. Contratos de auth en `shared/src/api/auth.ts`.
   - Sesión: `GET /auth/me` decide; sin sesión, las rutas privadas mandan a `/entrar?volver=…`.
     Entrar, crear cuenta y cerrar sesión de verdad; cada código de error con su mensaje (429 con los
     minutos de `Retry-After`).
   - Mis proyectos: listar, crear, importar zip, renombrar, borrar y descargar (`/export`).
   - Editor: proyecto, árbol y contenido reales (el texto se ve con `GET` del archivo, todavía sin editar);
     subir (botón y arrastrar a una carpeta), nuevo archivo (una subida vacía), renombrar o mover,
     borrar, documento principal, motor y nombre. Lo que depende del WebSocket (presencia, cursores,
     conexión) y de compilar sigue simulado hasta los pasos 3 y 4.
   - Compartir: miembros, roles, quitar, crear y revocar enlaces.
   - Unirse: **ruta nueva `GET /api/share/:token`** (con sesión) que devuelve el proyecto, el nombre del
     dueño, el rol del enlace y mi rol actual, sin unirse; así la pantalla muestra qué se acepta antes
     de tocar Unirme. Sin sesión, la pantalla pide entrar sin mostrar el proyecto.
   - Los parámetros de demo de las pantallas conectadas se van; quedan los del editor que dependen de los
     pasos 3 y 4.
3. **Editor en vivo:** CodeMirror 6 con y-codemirror.next sobre Hocuspocus, con cursores y presencia,
   subidas arrastrando y el árbol real.
   - Un `HocuspocusProvider` por proyecto abierto (`/collab`, documento `project:<id>`); la cookie viaja
     sola (mismo origen). Cada archivo de texto es el `Y.Text` de `files[fileId]`.
   - CodeMirror con LaTeX (`stex` de legacy-modes), historial, búsqueda, números de línea, línea activa y
     el tema con los tokens de Pliego. Lector, o documento demasiado grande: solo lectura.
   - Presencia por awareness (`user`: nombre, color, archivo abierto): avatares arriba y cursores con
     etiqueta (y-codemirror.next). El color sale del id del usuario, igual en todos los navegadores.
   - Conexión: Guardado (sin cambios pendientes), Sincronizando… o Sin conexión, reintentando.
   - Avisos del server: `files-changed` y `project-changed` recargan árbol y proyecto; cierre 4403
     (permisos) muestra "Tus permisos cambiaron" y relee el rol; si al reconectar no hay permiso, "Ya no
     tenés acceso"; cierre 4413, "El documento llegó al tamaño máximo" y solo lectura.
   - La barra de formato y Ctrl+B / Ctrl+I insertan LaTeX en el cursor.
   - Se van las demos `?vista` y `?aviso` y el documento de ejemplo; queda `?compilar=` hasta el paso 4.
     El minimapa del diseño queda para después (backlog).
4. **Compilar:** botón y atajos contra la API, PDF.js, panel de problemas con salto a la línea y SyncTeX.
   - Compilar (botón, Ctrl/⌘+S, Ctrl/⌘+Enter): espera hasta 3 s a que el server confirme lo escrito
     (`unsynced` en 0), porque compila el estado del server; después `POST /projects/:id/compile` y
     consulta `GET /compilations/:id` cada segundo hasta que termina. En cola, compilando con los segundos
     corriendo, o 503 `queue_full`: "Reintentá en N s" con el `Retry-After`. Cada persona ve sus
     compilaciones; no se comparten.
   - Resultado: `success`, `error` (con o sin PDF: latexmk en nonstopmode a veces lo genera), `timeout`,
     `failed` (infraestructura) o PDF demasiado grande (`pdfMissingReason: too_large`). Si la última no dio
     PDF, queda el anterior atenuado con el aviso; si dio PDF con errores, se muestra el nuevo y los errores
     van al panel.
   - PDF.js (`pdfjs-dist`): el PDF se baja con `fetch` (cookie de sesión) y se dibuja en canvas página por
     página, solo las que están cerca de la vista; zoom, ajustar al ancho o a la página, página actual y
     anterior o siguiente. Sin JavaScript del PDF (`isEvalSupported: false`, sin scripting), sin capa de
     texto ni enlaces por ahora.
   - Problemas y log: los diagnósticos reales en el panel (se abre solo si hay errores) y en el gutter del
     editor; clic salta al archivo y la línea. El log se baja al abrirlo y se puede descargar; el PDF
     también.
   - SyncTeX en el navegador: `output.synctex.gz` se descomprime con `DecompressionStream` y se lee con un
     parser propio (`synctex.ts`, con test). Las rutas del contenedor (`/work/./cap/intro.tex`) se
     emparejan por sufijo con las del proyecto. "Ver en el PDF" marca el bloque de la línea del cursor;
     clic en el PDF abre el archivo en la línea de ese punto.
   - Si la compilación venció (410, más de un día), el log o el SyncTeX piden volver a compilar.
   - Se van `?compilar=`, `lib/mock.ts` y la página y el log de muestra.

Los pasos 2 a 4 se detallan antes de empezarlos.

## Dependencias (paso 1)
- `react-router`: rutas de la web (stack de CLAUDE.md).
- `tailwindcss` y `@tailwindcss/vite`: estilos con los tokens del diseño (stack de CLAUDE.md).

## Criterios (paso 1)
- [x] Cada pantalla y estado de la lista de arriba se ve en claro y en oscuro.
- [x] Mis proyectos, entrada y unirse se usan a 390 px sin scroll horizontal.
- [x] Todo se alcanza con Tab; los diálogos cierran con Esc y devuelven el foco.
- [x] `pnpm typecheck`, `pnpm lint` y `pnpm --filter @latexweb/web build` en verde.

## Dependencias (paso 2)
- `@tanstack/react-query`: caché, carga y reintentos de las peticiones (stack de CLAUDE.md).

## Criterios (paso 2)
- [x] Con `docker compose up`, crear una cuenta, crear e importar proyectos, subir una imagen, compartir
      un enlace y unirse desde otra cuenta funciona en el navegador.
- [x] Sin sesión, `/` y `/proyectos/:id` mandan a entrar y vuelven después.
- [x] Un lector ve el editor en solo lectura y no ve acciones de edición.

## Dependencias (paso 3)
- `@hocuspocus/provider`, `yjs` y `y-protocols`: el cliente del server de colaboración (misma versión
  que `@hocuspocus/server`).
- `@codemirror/state`, `view`, `language`, `legacy-modes` (LaTeX), `commands`, `search` y
  `@lezer/highlight`: el editor, armado a mano en lugar del paquete `codemirror` (sin autocompletado ni
  plegado, que no se usan).
- `y-codemirror.next`: une CodeMirror con el Y.Text (cursores remotos y deshacer por persona).

## Criterios (paso 3)
- [x] Dos personas editan el mismo archivo y ven el texto y el cursor (con nombre) del otro al instante.
- [x] Pasar a alguien de lector a editor lo reconecta con el aviso y la barra de formato; quitarlo le
      muestra "Ya no tenés acceso".
- [x] Lo escrito sigue ahí al recargar; el indicador dice Guardado.
- [x] El editor va en su propio chunk (CodeMirror y Yjs se bajan al abrir un proyecto).

## Dependencias (paso 4)
- `pdfjs-dist`: dibujar el PDF en el navegador (stack de CLAUDE.md). SyncTeX y gzip sin dependencias.

## Criterios (paso 4)
- [x] Compilar un proyecto con imágenes muestra el PDF; uno con errores muestra los errores en el panel y
      en el gutter, y el clic lleva a la línea.
- [x] "Ver en el PDF" marca el párrafo de la línea del cursor y el clic en el PDF vuelve al código, también
      en un archivo de `\input`.
- [x] Log y PDF se descargan; zoom, ajuste y páginas funcionan con un PDF de varias páginas.

## Riesgos y pendientes del diseño
- Nombre del producto (Pliego o latexweb): está en una sola constante, `PRODUCT_NAME`.
- Dominio real de los enlaces para compartir; voseo o tuteo.
- Los 120 s de tiempo agotado y los 8 s de espera del diseño son ejemplos, no valores del backend.

## Cierre (2026-11-18)
- Verificación en vivo del paso 4 con un proyecto de prueba (`\input`, imagen, 3 páginas): compilar con
  Ctrl+S justo después de escribir (entra lo recién escrito), PDF con zoom, ajuste y páginas, SyncTeX en
  los dos sentidos (también en `cap/intro.tex`), error con PDF (se muestra el nuevo), error sin PDF (queda
  el anterior atenuado), log y PDF con su tipo, consola sin errores.
- Revisión de seguridad de la spec (web y los cambios del server): sin hallazgos críticos ni altos. El
  WebSocket del mismo origen exige antes un `Host` permitido; la vista previa de un enlace pide sesión,
  usa tokens de 256 bits y no expone el email del dueño; log, diagnósticos y rutas se muestran como texto;
  PDF.js no ejecuta el JavaScript del PDF; `?volver=` solo acepta rutas propias y navega dentro de la app.
