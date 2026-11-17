# Spec: compilación (v1)

## 1. Objetivo
Compilar un proyecto LaTeX enviado por HTTP en un sandbox seguro y permitir consultar el estado del trabajo y
descargar el PDF y el log. Es el núcleo del producto y la base sobre la que después se montan usuarios,
proyectos persistentes y MinIO.

## 2. Alcance
**Incluye**
- `POST /compilations`: subida multipart de los archivos del proyecto. Devuelve 202 con un id.
- `GET /compilations/:id` (estado), `GET /compilations/:id/pdf` y `GET /compilations/:id/log`.
- Validación de rutas, límites de tamaño y cantidad, documento principal y motor
  (pdflatex, xelatex, lualatex; se acepta el comentario mágico `% !TEX program`).
- Worker BullMQ que compila con latexmk en un contenedor Docker aislado: sin red, con límites de CPU, RAM,
  PIDs y tiempo, sin shell-escape (`shell_escape=f`), `-norc` y `openout_any=p`. El contenedor es el
  límite de seguridad (ver Riesgos: desde TL2026 `openin_any` no tiene efecto).
- Imagen propia de TeX Live (`apps/compiler/docker/`).
- Almacenamiento temporal en un directorio compartido del disco, con TTL y limpieza.
- Tests unitarios y de integración con los 6 fixtures de `fixtures/latex/`.

**No incluye**
- Usuarios, autenticación, base de datos ni MinIO.
- Rate limiting por cliente: el control es el tope de la cola más la concurrencia del worker.
- Parseo de errores del log (tendrá su propia spec), SyncTeX y compilación incremental (cada compilación
  empieza de cero).
- Subida en zip y frontend. (El worker dentro de un contenedor se agregó después, para uso local, en
  `docs/specs/docker-compose.md`; Docker sin root o gVisor quedan para la spec `despliegue`.)

## 3. Diseño

### Flujo
"La API" es la API REST de `apps/server`, el proceso que también sirve la colaboración (Hocuspocus). El
worker es `apps/compiler`, un proceso aparte.

1. La API recibe el multipart y valida cada ruta. Ignora `latexmkrc` y los archivos cuyo nombre empieza
   por `.`.
2. Resuelve el motor y el documento principal, genera un id con `randomUUID()` y escribe los archivos en
   `<root>/<id>/input/`.
3. Encola en `compile` el payload `{ compilationId, mainFile, engine }` con `jobId = id`. Los archivos nunca
   pasan por Redis.
4. El worker valida de nuevo `mainFile` y `engine`, ejecuta `docker run` con la imagen de TeX Live y publica
   `output.pdf` y `output.log` en `<root>/<id>/`.
5. La API consulta el estado del job en BullMQ y sirve los artefactos desde el disco.

### Almacenamiento (directorio compartido)
- La raíz es `COMPILE_STORAGE_DIR`, por defecto `path.join(os.tmpdir(), 'latexweb-compilations')`.
  Es una ruta absoluta, igual para la API y el worker, y Docker Desktop la comparte sin configurar nada.
- Estructura: `<root>/<id>/input/**` (lo escribe la API), `<root>/<id>/out/` (lo monta el contenedor) y
  `<root>/<id>/output.{pdf,log}` (los publica el worker con un rename atómico).
- Interfaces chicas por rol, para reemplazarlas por MinIO después sin tocar las rutas ni el processor:
  - API (`apps/server/src/features/compilations/storage.ts`): `saveInputs(id, files)`,
    `openArtifact(id, kind)` y `remove(id)`.
  - Worker (`apps/compiler/src/workspace/workspace.ts`): `prepareInputs(id)`, `publishArtifacts(id)`,
    `cleanupWork(id)` y `sweepExpired(maxAgeMs)`.
- `publishArtifacts` usa `lstat`, acepta solo archivos regulares y aplica un tamaño máximo.
- Al arrancar, el worker rechaza una raíz que contenga `,`, porque rompe la sintaxis de `--mount`.

### Validación (funciones puras en `packages/shared/src/project-paths.ts`)
- `normalizeProjectPath`:
  - Aplica NFC. Usa rutas POSIX relativas de 1 a 255 caracteres, con hasta 10 niveles.
  - Rechaza `\`, NUL, caracteres de control, `:`, `<>"|?*`, rutas absolutas (`/`, `C:`, `//`) y segmentos
    vacíos, `.` o `..`.
  - Rechaza segmentos que terminan en `.` o en espacio y nombres reservados de Windows
    (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
- Colisiones: rechaza duplicados al comparar sin distinguir mayúsculas y conflictos entre archivo y
  carpeta (`a` y `a/b`).
- `isIgnoredPath`: un segmento que empieza por `.` o un archivo llamado `latexmkrc` en cualquier nivel.
  Se ignoran (no se rechazan) y se informan en `ignoredFiles`. Lo que protege de verdad es `-norc`.
- `isValidMainFile`: patrón estricto `^(?:[A-Za-z0-9_][A-Za-z0-9_-]*/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.tex$`
  (ASCII, sin espacios y sin `-` al principio), porque latexmk arma comandos de `/bin/sh` con este nombre y
  un nombre como `-e…` se toma como opción. Por defecto es `main.tex` y tiene que estar entre los archivos
  subidos.
- `detectEngineFromSource`: lee como máximo las primeras 50 líneas que sean comentarios o estén en blanco,
  ignorando el BOM, y busca `/^%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)\s*$/i`. Un valor fuera de
  `ENGINES` se ignora. Prioridad: el campo `engine`, después el comentario mágico y por último `pdflatex`.
- Límites, configurables por variables de entorno: 20 MB por archivo, 50 MB en total y 200 archivos.
  Al superarlos se responde 413.

### Subida
- Multipart con `@fastify/multipart` (dependencia nueva, ver más abajo). Cada parte `files` lleva la ruta
  relativa en su `filename`, con `preservePath: true`. `mainFile` y `engine` van como campos de texto.
- Se bufferiza en memoria (como máximo 50 MB por request).
- Se descarta subir un zip porque suma una dependencia y superficie de ataque: bombas de descompresión,
  symlinks, `..` y codificaciones de nombres.

### Ejecución en Docker
Se usa `child_process.spawn('docker', args)` con los argumentos en un array (nunca `shell: true`). Los
argumentos salen de una función pura (`apps/compiler/src/docker/docker-args.ts`):

```
run --rm --name latexweb-compile-<id> --label latexweb.compile=<id> --init
  --network none --cpus 1 --memory 1g --memory-swap 1g --pids-limit 128
  --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m
  --tmpfs /work:rw,nosuid,nodev,noexec,size=256m,uid=<uid>,gid=<gid>,mode=0700
  --cap-drop ALL --security-opt no-new-privileges --user <uid>:<gid>
  --env openout_any=p --env shell_escape=f --env HOME=/tmp --env LATEXWEB_TIMEOUT=<s>
  --mount type=bind,source=<abs>/input,target=/in,readonly
  --mount type=bind,source=<abs>/out,target=/out
  <imagen> -norc -no-shell-escape -interaction=nonstopmode -file-line-error -jobname=output
  <-pdf|-pdfxe|-pdflua> <mainFile>
```

- **Montajes:** `/in` es de solo lectura. El script de entrada copia `/in` a `/work` (tmpfs de tamaño fijo,
  para que un bucle de `\write` no pueda llenar el disco del host), ejecuta latexmk en la raíz del proyecto
  (sin `-cd`, como Overleaf) y copia `output.pdf` y `output.log` a `/out`. TeX no puede escribir en `/out`
  porque `openout_any=p` prohíbe las rutas absolutas (verificado con `kpsewhich -safe-out-name`).
- **tmpfs `/work` con `uid`, `gid` y `mode=0700`:** sin esos parámetros, Docker lo monta como `root 755`
  (toma el modo del `WORKDIR` de la imagen) y el usuario de compilación no puede escribir.
- **`/tmp` es `noexec`:** se pone explícito aunque Docker ya lo aplica por defecto a `--tmpfs`, para no
  depender de ese valor. biber no necesita ejecutar desde ahí porque está descomprimido en la imagen
  (ver Imagen).
- **Entorno:** solo se pasan las variables de la lista de arriba, con `--env NOMBRE=valor`. Nunca
  `--env-file` ni `--env NOMBRE` sin valor (que reenvía la variable del worker). Así ningún secreto del
  worker llega al contenedor; lo verifica el canario del fixture `malicioso`.
- **`--mount` y no `-v`:** `-v` se confunde con la `C:` de las rutas de Windows.
- **Modo volumen (docker compose):** cuando el worker corre en un contenedor (`COMPILE_STORAGE_VOLUME`),
  los dos montajes pasan a ser `type=volume` del volumen `latexweb-compile-storage` con
  `volume-subpath=<id>/input` (readonly) y `<id>/out`, derivados solo del id. Los demás flags no cambian.
  Ver `docs/specs/docker-compose.md`.
- **Usuario:** en Linux es el `uid:gid` del worker. En Windows (o con el worker como root) se usa `10001:10001`, un uid sin cuenta en el host (verificado: escribe en
  `/out` con un bind mount de Windows).
- **Timeout en dos niveles:**
  - Dentro del contenedor, `timeout -k 5 $LATEXWEB_TIMEOUT latexmk …` devuelve 124 y aun así se copia el log.
  - Desde el worker, como respaldo, se ejecuta `docker kill` a los `timeout + 15 s`.
  - Antes de cada ejecución se hace `docker rm -f <nombre>`, que es idempotente y cubre el reintento después
    de una caída.
- **Imagen:** `apps/compiler/docker/Dockerfile`.
  - Base: `texlive/texlive:latest-full@sha256:07e80626…` (TL2026, índice multi-arquitectura). Es el
    esquema completo (unos 2,6 GB comprimida) para no perseguir paquetes faltantes. La imagen base trae
    `openin_any=a` y `shell_escape=p` (restringido).
  - `ENV openout_any=p shell_escape=f HOME=/tmp PAR_GLOBAL_TEMP=/opt/latexweb/biber-par`.
  - En el build se dejan preparadas:
    - **luaotfload:** base de nombres y cachés por fuente de Latin Modern y TeX Gyre en `TEXMFSYSVAR`
      (con `warmup-fonts.tex`).
    - **biber:** es un binario PAR que extrae sus `.so` recién al cargarlas, y en ejecución
      `PAR_GLOBAL_TEMP` es de solo lectura. Se ejecuta biber de forma amplia en el build
      (`warmup-biber.tex` sobre `biblatex-examples.bib`, validación del `.bcf` y conversión a biblatexml)
      y `inc.lock`, que PAR abre para escribir en cada ejecución, es un symlink al tmpfs.
    - `fc-cache`.
  - El `ENTRYPOINT` es `latexweb-compile.sh`. Como defensa en profundidad:
    - acepta solo la lista exacta de opciones de arriba (rechaza `-e`, `-r`, `-shell-escape` y cualquier
      otra, con exit 2);
    - vuelve a validar el documento principal con el mismo criterio que `isValidMainFile`;
    - arma él mismo la invocación de latexmk con `-norc -no-shell-escape`;
    - con lualatex, copia la base de nombres de luaotfload (~700 KB) al `TEXMFVAR` del tmpfs, porque
      luaotfload solo la busca ahí y si no la encuentra la regenera (~5 s por compilación);
    - publica en `/out` solo archivos regulares, aunque la compilación haya fallado.
  - Se construye con `pnpm --filter @latexweb/compiler image:build` y genera `latexweb-texlive:tl2026-2`.
    Al cambiar el Dockerfile se sube el sufijo. El worker la recibe en `COMPILE_IMAGE`.
  - Tiempos medidos con la imagen (incluye arrancar el contenedor): `articulo-simple` 1 s,
    `con-bibliografia` 3 s, `xelatex-fuentes` con lualatex 4 s.
- **Al arrancar**, el worker comprueba `docker version` y `docker image inspect`. Si fallan, se detiene con
  un mensaje claro.

### Estados y resultado
- La fuente de verdad es el job de BullMQ (no hay base de datos). `queue.add` usa
  `{ jobId: id, attempts: 1, removeOnComplete: { age: TTL, count: 1000 }, removeOnFail: { age: TTL, count: 1000 } }`.
- Los errores de LaTeX son un **resultado**, no una excepción:
  - `success`: código 0 y PDF presente.
  - `timeout`: código 124 o kill del respaldo.
  - `error`: cualquier otro caso. Si hay PDF parcial, se sirve igual.
  - Solo se lanza excepción ante fallos de infraestructura (códigos 125-127 de docker, I/O, payload
    inválido). Esos jobs quedan en `failed` y la API no expone el mensaje interno.
- **Motivo de la falta de PDF:** el resultado guarda `pdfMissingReason`:
  - `null` si se publicó un PDF;
  - `'not_produced'` si la compilación no generó PDF;
  - `'too_large'` si lo generó pero superaba `COMPILE_MAX_PDF_BYTES` y no se publicó.

  Un PDF demasiado grande cuenta como `error` aunque latexmk haya terminado con 0, porque no hay PDF
  utilizable. `publishArtifacts` informa los dos casos por separado (`hasPdf` y `pdfTooLarge`) y la API
  expone el motivo en el estado y como código de error en la descarga.
- Correspondencia de estados:

  | Estado de BullMQ | Estado expuesto |
  |---|---|
  | `waiting`, `delayed`, `prioritized` | `queued` |
  | `active` | `running` |
  | `completed` | `success`, `error` o `timeout` |
  | `failed` | `failed` |
  | inexistente | 404 |

- **Retención:** `COMPILE_TTL_SECONDS` (3600 por defecto).
  - Al terminar, el worker borra `input/` y `out/`.
  - Un barrido propio (al arrancar y cada 10 minutos) borra los `<root>/<uuid>` vencidos. Solo toca nombres
    con formato uuid. La limpieza de BullMQ no se usa como TTL porque se ejecuta tarde.
  - El estado incluye `expiresAt`. Si el job existe pero el archivo ya no, la respuesta es 410.
- **Concurrencia:** `COMPILE_CONCURRENCY`, 2 por defecto.

### Endpoints
`buildApp` (`apps/server/src/app.ts`, ya existe y monta `/health` y la colaboración) pasa a recibir sus
dependencias (`buildApp(deps)`: cola y storage) para poder testearla con `inject`. El servidor sigue
escuchando en `127.0.0.1`.

| Método y ruta | Respuestas |
|---|---|
| `POST /compilations` (multipart) | 202 con `Location` y `CreateCompilationResponse`. 400 por ruta inválida, duplicado, sin archivos, principal ausente o inválido, o motor inválido. 413 por tamaño o cantidad. 415 si no es multipart. 503 con `Retry-After` si la espera supera `COMPILE_MAX_QUEUED` (50) o Redis falla; en ese caso se borran los archivos ya guardados. |
| `GET /compilations/:id` | 200 con `CompilationStatusResponse`. 404 si el id no es un uuid (se comprueba antes de tocar el disco o Redis) o si no existe. |
| `GET /compilations/:id/pdf` | 200 `application/pdf` en streaming, con `Content-Disposition: inline`, `X-Content-Type-Options: nosniff` y `Content-Security-Policy: sandbox`. 404 si no existe la compilación (`not_found`), si no generó PDF (`artifact_not_available`) o si el PDF superó `COMPILE_MAX_PDF_BYTES` (`pdf_too_large`, con el límite en el mensaje). 409 si todavía no terminó. 410 si expiró. |
| `GET /compilations/:id/log` | Los mismos códigos. Se sirve como `text/plain; charset=utf-8` con `nosniff`. |

Los errores tienen la forma `{ error: CompilationErrorCode, message }`.

### Tipos compartidos (`packages/shared/src/compilation.ts`, TS puro, sin tipos de Node)
`ENGINES` / `Engine`, `ARTIFACT_FILES` / `ArtifactKind`, `CompileJobData`, `CompileOutcome`,
`CompileJobResult` (`outcome`, `exitCode`, `durationMs`, `hasPdf`, `hasLog`, `pdfMissingReason`),
`PdfMissingReason` (`'not_produced' | 'too_large'`), `CompilationStatus`, `CreateCompilationResponse`,
`CompilationStatusResponse` (con `createdAt`, `finishedAt`, `expiresAt`, `durationMs`, `exitCode`,
`pdfMissingReason`, `pdfUrl` y `logUrl`), `CompilationErrorCode` (incluye `pdf_too_large`) y `ApiError`.

### Dependencias
- **Nueva:** `@fastify/multipart` en `apps/server`. Es el plugin oficial de Fastify para multipart, trae
  límites de tamaño y cantidad, y parsear multipart a mano es propenso a errores.
- **Ya presentes en el monorepo:** `bullmq ^6.7.5` e `ioredis ^6.0.0` se agregan a `apps/server` para encolar
  y consultar el estado. Van con las mismas versiones que el compiler para que se resuelvan al mismo
  paquete.
- **No se usan:** dockerode, una librería de zip, `@fastify/rate-limit`, una librería de uuid
  (`node:crypto` alcanza), una librería de PDF ni dotenv.

## 4. Archivos
**Crear**
- `packages/shared/src/compilation.ts`, `project-paths.ts` y `project-paths.test.ts`
- `apps/compiler/docker/Dockerfile`, `latexweb-compile.sh`, `warmup-fonts.tex` y `warmup-biber.tex`
- `apps/compiler/src/`: `docker/docker-args.ts` (+ test), `docker/runner.ts` (+ test),
  `workspace/workspace.ts` (+ test) y `worker/processor.ts` (+ test)
- `apps/compiler/test/integration/compile.test.ts`
- `apps/server/src/features/compilations/`: `index.ts`, `routes.ts`, `storage.ts`, `upload.ts`, `queue.ts` y
  `status.ts`, cada uno con su `.test.ts` al lado
- `apps/server/src/plugins/multipart.ts` (registro de `@fastify/multipart` con sus límites)
- `.gitattributes` con `*.sh text eol=lf` y `Dockerfile text eol=lf` (con CRLF, `/bin/sh` falla en el
  contenedor)

**Modificar**
- `packages/shared/src/index.ts`: reexportar.
- `apps/compiler/src/index.ts` y `config.ts` (ya existen): processor real, concurrencia, barrido,
  comprobación de Docker y las variables `COMPILE_*`.
- `apps/server/src/config.ts` (ya existe): raíz de almacenamiento, Redis y límites de subida.
- `apps/compiler/package.json`: script `image:build`.
- `apps/server/src/app.ts` (`buildApp` recibe cola y storage y registra las rutas de compilación),
  `apps/server/src/index.ts` (crea la `Queue`) y `apps/server/package.json` (dependencias).
- `.env.example`: `COMPILE_STORAGE_DIR`, `COMPILE_IMAGE`, `COMPILE_TIMEOUT_SECONDS=60`,
  `COMPILE_MEMORY=1g`, `COMPILE_CPUS=1`, `COMPILE_CONCURRENCY=2`, `COMPILE_TTL_SECONDS=3600`,
  `COMPILE_MAX_QUEUED=50`, `COMPILE_MAX_PDF_BYTES` (50 MB), `COMPILE_MAX_LOG_BYTES` (5 MB) y los
  límites de subida.

## 5. Pasos
Al terminar cada paso se corren `pnpm test`, `pnpm typecheck` y `pnpm lint`.

1. **Shared:** tipos y validadores, con tests en tabla para rutas, nombres reservados, colisiones,
   comentario mágico y patrón del principal (`-e.tex`, `a"b.tex`, `x$y.tex`).
2. **Imagen:** Dockerfile, script e `image:build`.
   - Verificar a mano que `kpsewhich -var-value` devuelve `openout_any=p` y `shell_escape=f`.
   - Compilar a mano una copia de `articulo-simple`.
   - Comprobar que el uid 1000 puede escribir en `/out` con un bind mount de Windows.
3. **`docker/docker-args.ts`:** con tests de que aparecen `--network none`, `-norc` y `-no-shell-escape`, de que
   ningún argumento habilita shell-escape, del usuario en Windows y en Linux (y del mismo uid/gid en el
   tmpfs de `/work`), de que hay exactamente dos `--mount` (`/in` de solo lectura y `/out`), de que cada
   `--env` tiene la forma `NOMBRE=valor` y su nombre está en la lista blanca, de que no aparece
   `--env-file`, y de que `mainFile` va al final.
4. **`workspace/workspace.ts`:** publicación con `lstat` y tamaño máximo, y barrido que solo toca uuids. Con tests en
   directorios temporales.
5. **`docker/runner.ts`:** spawn, doble timeout y correspondencia de códigos. Los tests de integración van en
   `apps/compiler/test/integration/compile.test.ts` y se corren con `pnpm test:integration` (`vitest.integration.config.ts`),
   no con `pnpm test`, porque tardan ~30 s con Docker real. Cubren:
   - los 6 fixtures;
   - `malicioso`, con `LATEXWEB_CANARY` definida en el entorno del proceso de test (el que lanza docker);
   - xelatex-fuentes forzado a lualatex;
   - timeout con `\def\x{\x}\x` y un límite de 5 s, sin dejar contenedores vivos;
   - un error de LaTeX, que termina en `error` y no como fallo de infraestructura;
   - el kill de respaldo del worker, con un contenedor que ignora el timeout interno.
6. **Processor e `index.ts` del worker.** Verificar que el worker arranca y que falla con un mensaje claro
   cuando no hay imagen.
7. **API (en `apps/server`):** `buildApp(deps)`, configuración, storage y subida, con tests de `inject`,
   una cola falsa y un directorio temporal. Incluye comprobar que `preservePath` funciona y que
   `features/collab/websocket.test.ts` sigue pasando.
8. **Rutas de estado y descarga:** 404, 409, 410 y cabeceras, con sus tests.
9. **Prueba de punta a punta:** `docker compose up -d redis`, `pnpm dev`, y con curl subir `con-imagenes` y
   `xelatex-fuentes`, consultar el estado y descargar el PDF y el log. Actualizar `.env.example`.

## 6. Criterios de aceptación
- [x] `POST /compilations` con los archivos de cada fixture devuelve 202 y un uuid. Al consultar el estado
      llega a `success` y se descarga un PDF que empieza con `%PDF`.
- [x] `xelatex-fuentes` se compila con XeLaTeX sin enviar `engine`, solo por el comentario mágico.
- [x] `con-bibliografia` ejecuta biber, y en el log no aparecen `Citation … undefined` ni
      `Please (re)run Biber`.
- [x] El log de `beamer` contiene `Output written on output.pdf (5 pages`.
- [x] El log de `malicioso` contiene `LATEXWEB-SANDBOX: FIN`, las 5 claves de intento
      (`shell-escape-nivel`, `write18-ejecucion`, `write18-etc-passwd`, `canario-entorno` y
      `latexmkrc-perl`) con `=BLOQUEADO` y ninguna línea `=VULNERABLE`. Este test se corre **sin** filtrar
      `latexmkrc`, para probar `-norc`, y con `LATEXWEB_CANARY` definida en el entorno del worker.
- [x] Rutas con `../`, absolutas, con `\` o con `C:` → 400. `latexmkrc` y `.latexmkrc` aparecen en
      `ignoredFiles` y no se escriben en el disco.
- [x] Al superar un límite de tamaño o cantidad → 413. Sin `main.tex` → 400 `main_file_missing`.
- [x] Un documento con bucle infinito termina en `timeout` dentro de `COMPILE_TIMEOUT_SECONDS + 20 s`, con
      el log disponible y sin contenedor vivo en `docker ps`.
- [x] Un documento con errores de LaTeX termina en `error` (no en `failed`) y su log se puede descargar.
- [x] Un PDF que supera `COMPILE_MAX_PDF_BYTES` deja el estado en `error` con
      `pdfMissingReason: 'too_large'`, y `GET /compilations/:id/pdf` responde 404 `pdf_too_large`.
- [x] Un id inexistente o mal formado → 404. Una descarga antes de terminar → 409. Una descarga después
      del TTL → 410.
- [x] El PDF se sirve con `nosniff` y `CSP: sandbox`, y el log como `text/plain`.
- [x] Los argumentos de `docker run` incluyen `--network none`, límites de CPU, memoria y PIDs, `--read-only`
      y `--cap-drop ALL`, no aparece ninguna opción que habilite shell-escape, solo hay dos montajes
      (`/in` y `/out`) y solo variables de entorno de la lista blanca con valor explícito.
- [x] Sin Docker, los tests de integración se saltan. Con `LATEXWEB_REQUIRE_DOCKER=1` fallan.
- [x] `pnpm test`, `pnpm typecheck` y `pnpm lint` pasan.

## 7. Riesgos
**Seguridad**
- **Socket de Docker:** quien accede a él tiene root en el host. Con `pnpm dev` el worker corre en el host;
  con `docker compose up` corre en un contenedor que monta el socket (riesgo aceptado para uso
  local, ver `docs/specs/docker-compose.md` §7). Para producción hace falta Docker sin root o gVisor
  (`--runtime runsc`), porque el kernel es compartido.
- **Inyección vía latexmk:** latexmk ejecuta cadenas con `/bin/sh`. El patrón estricto de `mainFile` es
  obligatorio en la API **y** en el worker. Nunca usar `-e` ni `-r` con datos del usuario.
- **TeX puede leer cualquier archivo del contenedor.** Desde TeX Live 2026, `openin_any` no tiene efecto
  (`texmf.cnf`: "as of 2026, openin_any no longer has any effect"; verificado con
  `kpsewhich -safe-in-name`: ningún modo bloquea rutas absolutas, `..` ni dotfiles). El límite de seguridad
  es el contenedor, y por eso tiene que seguir sin nada que valga la pena leer:
  - solo se montan `/in` y `/out` del trabajo, nunca la raíz de almacenamiento ni otros directorios;
  - solo se pasan las variables de entorno de la lista blanca, con valor explícito (lo verifica el canario
    `LATEXWEB_CANARY` del fixture `malicioso`);
  - la imagen no contiene secretos (TeX Live y Debian, ambos públicos).

  Cualquier cambio en los montajes o en el entorno tiene que revisarse con este criterio.
- **Acceso por id:** sin autenticación, quien conozca el uuid puede descargar el PDF y el log. Es aceptable
  en v1.
- **Artefactos del contenedor:** son datos no confiables. Se publican con `lstat`, solo si son archivos
  regulares y con tamaño máximo, y se sirven con `nosniff` y `CSP: sandbox`.

**Rendimiento**
- **Imagen:** pesa unos 5 GB, así que la primera descarga es lenta. Cada contenedor tarda alrededor de 1 s
  en arrancar.
- **Compilaciones desde cero:** sin caché de `.aux`, una bibliografía necesita 3 o 4 pasadas.
- **Memoria:** el tmpfs cuenta dentro de `--memory`. Documentos grandes con lualatex pueden necesitar más
  memoria, por eso es configurable. v1 no distingue un OOM de un error de LaTeX.
- **API:** bufferiza hasta 50 MB por request.

**Casos borde**
- Archivos del usuario llamados `output.*` en la raíz chocan con `-jobname=output`. Queda documentado.
- Con el principal en una subcarpeta, las rutas son relativas a la raíz del proyecto.
- Duplicados por mayúsculas o por diferencias NFC/NFD. Logs con bytes que no son UTF-8.
- En Windows el barrido puede encontrar EBUSY si un archivo se está descargando. Se ignora y se reintenta
  en el siguiente barrido.
- Docker Desktop apagado: el worker se detiene con un mensaje claro.
- Si se pierde `.gitattributes`, el script queda con CRLF.

- **biber y bibliotecas nativas no extraídas:** el precalentamiento del build extrae las 49 bibliotecas que
  biber carga en la práctica, de las 83 que trae (el resto son de funciones como fuentes remotas, que de
  todos modos fallan sin red, o codificaciones CJK antiguas). Si un proyecto usa una función que necesita
  una que falta, biber falla con "Read-only file system". Su mensaje no queda en `output.log` sino en
  `output.blg`, que v1 no publica.

**Supuestos a verificar durante la implementación**
- Que `@fastify/multipart` le pasa `preservePath` a busboy (paso 7). Si no, la ruta va en el nombre del
  campo.
- ~~El tag y el digest de `texlive/texlive`, y que biber se extrae como binario PAR (paso 2).~~ Verificado
  en el paso 2 (ver Imagen).
