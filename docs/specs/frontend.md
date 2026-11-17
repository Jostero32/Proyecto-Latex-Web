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
  (código, rutas y log). STIX Two Text solo para simular el PDF mientras no hay PDF.js.
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
4. **Compilar:** botón y atajos contra la API, PDF.js, panel de problemas con salto a la línea y SyncTeX.

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

## Riesgos y pendientes del diseño
- Nombre del producto (Pliego o latexweb): está en una sola constante, `PRODUCT_NAME`.
- Dominio real de los enlaces para compartir; voseo o tuteo.
- Los 120 s de tiempo agotado y los 8 s de espera del diseño son ejemplos, no valores del backend.
