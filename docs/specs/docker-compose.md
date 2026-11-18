# Spec: apps en docker compose

> **Rutas viejas:** esta spec es anterior a la estructura plana (`backend.md`, paso 1). `apps/server` es hoy
> `server/`, `apps/compiler` es `compiler/`, `apps/compiler/docker` es `compiler/texlive/`, `apps/web` es `web/` y
> `packages/shared` es `shared/`.

## 1. Objetivo
Poder levantar todo el sistema (infraestructura, `server`, `compiler` y `web`) con docker compose, sin
instalar Node ni pnpm en el host. Hoy compose levanta solo la infraestructura y las apps corren en el host
con `pnpm dev`.

## 2. Alcance
**Incluye**
- `Dockerfile` en la raíz, multi-etapa, con un target por app: `server`, `compiler` y `web`.
- Servicios nuevos en `docker-compose.yml` (sin perfil: `docker compose up` levanta toda la app), más un
  servicio que construye la imagen `latexweb-texlive`.
- Modo **volumen** para la compilación: el worker en un contenedor lanza las compilaciones con el
  socket de Docker del host y monta la subcarpeta del trabajo desde un volumen con nombre
  (`volume-subpath`), en lugar de rutas del host.
- `SERVER_HOST` (el servidor tiene que escuchar en `0.0.0.0` dentro de su contenedor).

**No incluye**
- Configuración de producción, TLS, Docker sin root o gVisor (spec `despliegue` del roadmap).
- Recarga en caliente dentro de los contenedores: para desarrollar se sigue usando `pnpm dev`.
- CI (spec `ci`).

## 3. Diseño

### Dos formas de correr el sistema
| Comando | Qué levanta | Compilación |
|---|---|---|
| `docker compose up -d --build` | postgres, redis, minio, texlive-image, server, compiler y web | Modo **volumen** |
| `docker compose up -d postgres redis minio` + `pnpm dev` | solo la infraestructura; las apps en el host | Modo **bind** |

> **Cambio posterior:** la primera versión ponía las apps bajo un perfil `apps`, para que
> `docker compose up -d` siguiera levantando solo la infraestructura. Se quitó el perfil a pedido del
> usuario: con `docker compose up` corre toda la app, y para `pnpm dev` se nombran los servicios de
> infraestructura.

### Endurecimiento de los servicios (hallazgos de revisor-seguridad)
- `server`, `compiler` y `web`: `no-new-privileges`, `cap_drop: [ALL]`, raíz de solo lectura y tmpfs en
  `/tmp`. `web` tiene además un tmpfs del uid `node` para `node_modules/.vite-temp`.
- `compiler` recupera solo `CHOWN`, `DAC_OVERRIDE` y `FOWNER` (crear y entregar `out/` en el volumen del
  server) y está **solo** en la red interna `queue-compiler` con redis (el server usa otra,
  `queue-server`): no alcanza a postgres, minio ni al server (verificado).
- Cada imagen instala solo las dependencias de su app (`pnpm install --prod --filter <app>...`; `tsx`
  pasó a ser dependencia de server y compiler). pnpm se instala con `corepack install`, que verifica el
  hash de `packageManager`.

### Por qué un volumen con subpath
Las compilaciones son contenedores **hermanos** del worker: el worker se los pide al daemon del host
por el socket, así que no pueden montar rutas del contenedor del worker. En cambio, todos comparten un
volumen con nombre, `latexweb-compile-storage`:
- `server` y `compiler` lo montan en `/data/compilations` (`COMPILE_STORAGE_DIR`);
- cada compilación monta solo su subcarpeta:
  ```
  --mount type=volume,source=latexweb-compile-storage,target=/in,volume-subpath=<id>/input,readonly
  --mount type=volume,source=latexweb-compile-storage,target=/out,volume-subpath=<id>/out
  ```

Verificado en Docker 29.5.3 (API 1.54) con todos los flags del sandbox:
- `articulo-simple` compila (exit 0) y el PDF queda en `<id>/out/`;
- `/in` es de solo lectura (`touch: Read-only file system`) y el uid 1000 escribe en `/out`;
- Docker rechaza escapar del subpath: `..` y rutas absolutas ("subpath must be a relative path within
  the volume") y symlinks del volumen que apuntan afuera ("path concatenation escapes the base
  directory").

### Cambios en el código
- **`apps/compiler/src/config.ts`:** `COMPILE_STORAGE_VOLUME`. Si está definida, se usa el modo volumen; si
  no, el modo bind (el actual, para `pnpm dev`).
- **`apps/compiler/src/docker/docker-args.ts`:** los montajes pasan a ser una unión:
  - `{ kind: 'bind', inputDir, outputDir }` (lo actual);
  - `{ kind: 'volume', volume }`. Los subpaths `<id>/input` y `<id>/out` se arman **solo** a partir del
    id ya validado como uuid. El nombre del volumen se valida con `^[A-Za-z0-9][A-Za-z0-9_.-]*$`.

  Siguen siendo exactamente dos `--mount`, con `/in` `readonly`. Los demás flags no cambian.
- **`apps/compiler/src/worker/processor.ts`:** elige el modo según la configuración.
- **`apps/server/src/config.ts`:** `SERVER_HOST`, por defecto `127.0.0.1`.

### Imágenes (`Dockerfile` en la raíz)
> **Cambio posterior (2026-11-18):** el `Dockerfile` de la raíz con tres targets se separó en
> `server/Dockerfile`, `compiler/Dockerfile` y `web/Dockerfile`, uno por app. El contexto sigue siendo la
> raíz, porque el lockfile y `shared/` son del workspace (`build: { context: ., dockerfile: server/Dockerfile }`).
> Lo que entra al contexto lo decide un `Dockerfile.dockerignore` al lado de cada uno, que deja pasar solo
> lo que usa esa imagen; ya no hay `.dockerignore` en la raíz. Las imágenes y los flags no cambiaron.

- **Base:** `node:22-bookworm-slim` fijada por digest, con corepack y pnpm `12.18.0`, el mismo que
  `packageManager`.
  - Instala con `pnpm install --frozen-lockfile`; sin build: las apps corren con `tsx`, igual que en
    desarrollo.
  - `.dockerignore` excluye `node_modules`, `.git`, `dist` y `.env*`.
- **`server`:** usuario `node` (uid 1000). Escucha en `0.0.0.0:3000` y compose lo publica **solo** en
  `127.0.0.1:53000`. Healthcheck sobre `/health`.
- **`compiler`:**
  - **Binario de `docker`:** se copia desde `docker:29-cli`, fijada por digest. Es la única forma de que
    `runContainer` y `checkDocker` funcionen sin cambiar su código; no se agrega ninguna dependencia de npm.
  - **Socket:** monta `/var/run/docker.sock`.
  - **Usuario root dentro de su contenedor**, por el socket. Con el worker como root, el código actual ya
    lanza las compilaciones como `10001:10001` y hace `chown` de `out/` (`resolveContainerUser`).
  - En Linux, si se corre como no root, se usaría `group_add` con el GID del grupo `docker`; queda
    documentado, no se implementa.
- **`web`:** `vite build` y `vite preview --host 0.0.0.0 --port 5173`, publicado en `127.0.0.1:55173`.
  `vite preview` escribe en `node_modules/.vite-temp` al arrancar: esa carpeta se crea en la imagen con
  dueño `node` (sin eso, el contenedor fallaba con EACCES).
- **Arranque:** las apps arrancan con `node` + `tsx` directamente (no `pnpm start`), para que las
  señales de apagado lleguen al proceso.
- **`texlive-image`:** construye `latexweb-texlive:tl2026-2` desde `apps/compiler/docker/` y termina
  (`entrypoint: ["true"]`). `compiler` espera a que termine bien (`service_completed_successfully`).

### Compose
- `server` depende de `redis` healthy. `compiler` depende de `redis` healthy y de `texlive-image`.
  `web` depende de `server` healthy.
- Volumen `latexweb-compile-storage` con `name:` explícito, para no depender del prefijo del proyecto.
- Variables: `REDIS_URL=redis://redis:6379`, `COMPILE_STORAGE_DIR=/data/compilations`,
  `COMPILE_STORAGE_VOLUME=latexweb-compile-storage` y `SERVER_HOST=0.0.0.0`. Las demás `COMPILE_*` usan
  sus valores por defecto, salvo que se definan en `.env`.

## 4. Archivos
**Crear:** `Dockerfile`, `.dockerignore` y `apps/compiler/test/integration/volume-mode.test.ts`.

**Modificar:**
- `docker-compose.yml`;
- `apps/compiler/src/config.ts`, `docker/docker-args.ts` y `worker/processor.ts`, con sus tests;
- `apps/server/src/config.ts`, con su test;
- `.env.example`, `CLAUDE.md` (sección Comandos) y `docs/specs/compilacion.md` (el modo volumen en
  "Ejecución en Docker" y "Riesgos").

## 5. Pasos
1. **Configuración:** `SERVER_HOST` y `COMPILE_STORAGE_VOLUME`, con tests.
2. **Modo volumen en `docker-args` y en el processor**, con tests unitarios:
   - exactamente dos montajes;
   - `/in` readonly;
   - subpaths derivados solo del id;
   - rechazo de nombres de volumen inválidos;
   - el modo bind sin cambios.
3. **Test de integración del modo volumen:** crea un volumen, lo llena con un contenedor auxiliar,
   compila `articulo-simple` y `malicioso` con `runContainer` y verifica el PDF y las 5 claves BLOQUEADO.
4. **`Dockerfile` y `.dockerignore`:** construir los tres targets.
5. **Compose:** servicios, volumen y healthchecks.
6. **Verificación:**
   - `docker compose up -d --build`;
   - `/probar-compilacion` contra `127.0.0.1:3000` (6/6);
   - `malicioso` con `LATEXWEB_CANARY` definida en el servicio `compiler`;
   - `revisor-seguridad` sobre el diff;
   - documentación.

## 6. Criterios de aceptación
- [ ] `docker compose up -d --build` levanta todo y `/probar-compilacion` da 6/6 en `success`
      contra el servidor en contenedor.
- [ ] `docker compose up -d postgres redis minio` levanta solo la infraestructura y `pnpm dev` funciona
      como antes.
- [ ] En modo volumen, `malicioso` da las 5 claves BLOQUEADO con `LATEXWEB_CANARY` definida en el contenedor
      del worker.
- [ ] Los argumentos en modo volumen tienen exactamente dos `--mount` de tipo `volume`, `/in` readonly y
      subpaths `<uuid>/input` y `<uuid>/out`; los demás flags del sandbox no cambian.
- [ ] `server` y `web` solo se publican en `127.0.0.1`.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` y `pnpm test:integration` pasan.

## 7. Riesgos
- **Socket de Docker en un contenedor:** el contenedor `compiler` tiene, en la práctica, root sobre el
  host. Hoy el worker en el host ya lanza contenedores, pero ahora el acceso queda dentro de un contenedor
  con dependencias de npm. Es aceptable para uso local. Para producción hace falta Docker sin root o
  gVisor (spec `despliegue`).
- **Volumen compartido:** `server` y `compiler` ven todas las compilaciones, igual que hoy con la carpeta
  compartida. Las compilaciones solo ven su subcarpeta, y Docker impide escapar de ella (verificado).
  Eso depende de que el daemon soporte `volume-subpath` (API ≥ 1.45, Docker 26): en modo volumen el worker
  lo comprueba al arrancar y se detiene si la API es anterior.
- **Worker root sobre carpetas del server:** `<id>/` es del uid 1000 del server, y el worker es root.
  Un server comprometido podría dejar symlinks para que el worker escriba o cambie dueños donde no
  debe. Por eso el worker hace `chown` sobre el descriptor (`O_NOFOLLOW|O_DIRECTORY` y `fchown`) y crea
  el temporal del log con `O_CREAT|O_EXCL|O_NOFOLLOW`. Hallazgo de `revisor-seguridad`.
- **Linux:** con Docker Engine anterior a 28, los puertos publicados en `127.0.0.1` podían ser accesibles
  desde la misma red L2 (según las notas de versión, no verificado). Se recomienda Docker Engine 28 o
  posterior.
- **El barrido sigue funcionando** dentro del worker sobre `/data/compilations`. Los datos persisten entre
  reinicios del stack mientras exista el volumen.
- **Tamaño:** la imagen de las apps suma unos cientos de MB (Node y dependencias) a los ~5 GB de TeX Live,
  y el primer `--build` tarda.
- **Linux sin Docker Desktop:** el GID del socket varía según la distribución. Queda documentado para
  cuando el worker deje de correr como root.
