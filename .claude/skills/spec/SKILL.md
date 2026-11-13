---
name: spec
description: Escribe la especificación de una funcionalidad antes de programarla. Usar cuando se pida planear o especificar una funcionalidad nueva.
---

# Escribir spec

El argumento es el nombre de la funcionalidad. Crea `docs/specs/<nombre>.md` con:

1. **Objetivo**: qué problema resuelve, en 2-3 líneas
2. **Alcance**: qué incluye y qué NO incluye
3. **Diseño**: componentes, endpoints, modelos de datos y flujo
4. **Archivos**: lista de archivos a crear o modificar
5. **Pasos**: implementación dividida en pasos pequeños y verificables
6. **Criterios de aceptación**: lista comprobable
7. **Riesgos**: seguridad, rendimiento, casos borde

Para el diseño, delega la investigación del código al subagente `arquitecto`.
No escribas código de la aplicación; solo la spec.
Al final, muestra un resumen y pregunta si se aprueba.