---
name: spec
description: Escribe la especificación de una funcionalidad antes de programarla. Usar cuando se pida planear o especificar una funcionalidad nueva.
---

# Escribir spec

El argumento es el nombre de la funcionalidad. Crea `docs/specs/<nombre>.md`, corta (~1 página), con:

1. **Objetivo**: qué problema resuelve, en 2-3 líneas
2. **Alcance**: qué incluye y qué NO incluye
3. **Diseño**: componentes, endpoints, modelos de datos y flujo; solo las decisiones que importan
4. **Archivos**: lista de archivos a crear o modificar, siguiendo "Estructura de carpetas" de CLAUDE.md
5. **Pasos**: pocos y de alcance grande. Cada paso entrega una parte completa y usable de la
   funcionalidad (rutas + lógica + persistencia + tests) y termina en un commit con
   `pnpm test`, `pnpm typecheck` y `pnpm lint` en verde
6. **Criterios de aceptación**: lista comprobable
7. **Riesgos**: seguridad, rendimiento, casos borde; solo los relevantes

Investiga el código tú mismo (no delegues en subagentes) y verifica los supuestos técnicos de los que
dependa el diseño antes de escribirlos. No escribas código de la aplicación; solo la spec.
Al final, muestra un resumen y pregunta si se aprueba.
