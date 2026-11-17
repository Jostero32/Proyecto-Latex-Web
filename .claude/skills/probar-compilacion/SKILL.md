---
name: probar-compilacion
description: Prueba de punta a punta de la compilación A TRAVÉS DE LA API (POST /compilations, polling del estado, descarga de PDF y log) con los fixtures de fixtures/latex/, y reporta una tabla con fixture, estado, tiempo y primer error. Usar después de cambiar la API de compilación, el worker o la imagen, o cuando se pida probar la compilación de punta a punta.
---

# Probar la compilación a través de la API

Complementa a `pnpm test:integration`, que llama al runner directamente y **no** pasa por la API.
Esta skill prueba el camino completo que usa un cliente: subida multipart → cola de Redis → worker →
Docker → publicación → estado y descargas HTTP. No repitas aquí lo que ya cubren los tests de
integración (aserciones finas sobre el log, timeout, kill de respaldo).

## 1. Preparar el entorno

1. Redis arriba: `docker compose up -d redis` (comprobar `docker compose ps`: `healthy`).
2. Imagen de compilación presente: `docker image inspect latexweb-texlive:tl2026-2`. Si falta:
   `pnpm --filter @latexweb/compiler image:build` (la primera vez descarga ~2,6 GB).
3. Servidor y worker corriendo. Si `GET http://127.0.0.1:3000/health` ya responde `{"ok":true}`,
   usar lo que está corriendo y **no** detenerlo al final. Si no:
   - Arrancar `pnpm --filter @latexweb/server start` y `pnpm --filter @latexweb/compiler start` en
     segundo plano, **fuera del sandbox de la shell**. En Windows, con la herramienta PowerShell: si se
     arrancan desde el Bash con sandbox, los archivos que escribe el servidor tardan minutos en ser
     visibles para Docker y las compilaciones fallan por `main.tex` ausente, no por el código.
   - Esperar a que `/health` responda (hasta 30 s) y anotar que hay que detenerlos al final.

## 2. Ejecutar

```
node .claude/skills/probar-compilacion/probar.mjs [--base http://127.0.0.1:3000] [--fixtures fixtures/latex] [--timeout 120]
```

El script (solo módulos de Node 22, sin dependencias), para cada carpeta de `fixtures/latex/`:
- sube **todos** sus archivos con su ruta relativa (incluido el `latexmkrc` de `malicioso`, que la
  API debe ignorar e informar en `ignoredFiles`), sin enviar `engine` (el motor sale del comentario
  mágico o del valor por defecto);
- consulta `GET /compilations/:id` cada 500 ms hasta un estado final o el timeout;
- descarga `/pdf` (comprueba que empieza con `%PDF-`) y `/log`;
- extrae el primer error del log (`! …` o `archivo:línea: …` de `-file-line-error`); en `malicioso`,
  además, cualquier línea `LATEXWEB-SANDBOX: …=VULNERABLE`.

Imprime una tabla Markdown y termina con código 0 solo si todos los fixtures llegan a `success` con PDF
válido y `malicioso` no tiene ninguna línea `VULNERABLE`.

## 3. Reportar

Mostrar la tabla tal cual y, debajo:
- los fixtures que fallaron, con el primer error y la acción sugerida;
- cualquier respuesta HTTP inesperada que el script haya informado (código y cuerpo);
- si se arrancaron servicios en el paso 1, confirmar que se detuvieron.

No modificar código para que la prueba pase: si algo falla, reportarlo.

## 4. Limpiar

Detener solo los procesos que se arrancaron en el paso 1. Los artefactos de las compilaciones los
borra el barrido del worker al vencer el TTL; no borrar a mano la raíz de almacenamiento.
