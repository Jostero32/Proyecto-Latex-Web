// Todo lo de Docker del worker: argumentos de `docker run` (función pura), ejecución del contenedor
// con su clasificación, y la comprobación al arrancar. Ver docs/specs/compilacion.md, "Ejecución en Docker".
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { isCompilationId, isEngine, isValidMainFile, type CompileOutcome, type Engine } from '@latexweb/shared';

// --- Argumentos de docker run ---

/** Opción de latexmk para cada motor. */
export const ENGINE_FLAGS = {
  pdflatex: '-pdf',
  xelatex: '-pdfxe',
  lualatex: '-pdflua',
} as const satisfies Record<Engine, string>;

/**
 * Únicas variables de entorno que recibe el contenedor, siempre con valor explícito.
 * Nunca --env-file ni `--env NOMBRE` sin valor: reenviarían el entorno del worker, y TeX
 * puede leer /proc/self/environ (desde TL2026 openin_any no tiene efecto).
 */
export const CONTAINER_ENV_NAMES = ['openout_any', 'shell_escape', 'max_print_line', 'HOME', 'LATEXWEB_TIMEOUT'] as const;

/** Usuario del contenedor cuando no se puede usar el del worker (Windows, macOS sin getuid, o root). */
// uid sin cuenta en el host: 1000 suele ser el primer usuario humano de un Linux, y un escape o un
// archivo que quede tendría su identidad.
export const FALLBACK_CONTAINER_USER: Readonly<ContainerUser> = Object.freeze({ uid: 10001, gid: 10001 });

export interface ContainerUser {
  uid: number;
  gid: number;
}

export interface DockerRunOptions {
  compilationId: string;
  image: string;
  engine: Engine;
  mainFile: string;
  /** Ruta absoluta en el host del directorio con los archivos del proyecto (se monta en /in, solo lectura). */
  inputDir: string;
  /** Ruta absoluta en el host donde el contenedor deja output.pdf y output.log (se monta en /out). */
  outputDir: string;
  timeoutSeconds: number;
  cpus: number;
  /** Límite de memoria (incluye los tmpfs), p. ej. `1g`. También se usa como --memory-swap: sin swap. */
  memory: string;
  pidsLimit: number;
  /** Tamaño de los tmpfs /tmp y /work, p. ej. `256m`. */
  tmpfsSize: string;
  /**
   * Tamaño máximo de cualquier archivo que escriba la compilación (--ulimit fsize, en bytes).
   * Acota lo que pueda escribirse en /out aunque una herramienta ignore openout_any.
   */
  maxFileBytes: number;
  user: Readonly<ContainerUser>;
  /**
   * Modo volumen (worker dentro de docker compose, ver docs/specs/docker-compose.md): si está
   * definido, /in y /out se montan desde este volumen con nombre usando volume-subpath
   * `<id>/input` y `<id>/out`, en lugar de inputDir/outputDir (que son rutas del contenedor del
   * worker y el daemon del host no puede montar).
   */
  storageVolume?: string | undefined;
}

/** Nombre del contenedor; permite `docker kill` / `docker rm -f` idempotentes por compilación. */
export function containerName(compilationId: string): string {
  assertCompilationId(compilationId);
  return `latexweb-compile-${compilationId}`;
}

/**
 * Usuario con el que corre el contenedor. En Linux, el uid/gid del worker, para que los
 * artefactos de /out le pertenezcan. Nunca root: si el worker corre como root (o la plataforma
 * no tiene getuid, como Windows) se usa 10001:10001 y el directorio de salida debe ser escribible
 * por ese uid.
 */
export function resolveContainerUser(
  getuid: (() => number) | undefined = process.getuid,
  getgid: (() => number) | undefined = process.getgid,
): Readonly<ContainerUser> {
  if (getuid === undefined || getgid === undefined) return FALLBACK_CONTAINER_USER;
  const uid = getuid();
  const gid = getgid();
  if (uid === 0 || gid === 0) return FALLBACK_CONTAINER_USER;
  return { uid, gid };
}

export function buildDockerRunArgs(options: DockerRunOptions): string[] {
  const { compilationId, image, engine, mainFile, inputDir, outputDir, user } = options;

  const name = containerName(compilationId);
  if (!isEngine(engine)) throw new DockerArgsError(`motor inválido: ${String(engine)}`);
  if (!isValidMainFile(mainFile)) throw new DockerArgsError(`documento principal inválido: ${mainFile}`);
  assertImage(image);
  assertMountSource(inputDir, 'inputDir');
  assertMountSource(outputDir, 'outputDir');
  if (options.storageVolume !== undefined) assertVolumeName(options.storageVolume);
  assertPositiveInteger(options.timeoutSeconds, 'timeoutSeconds');
  assertPositiveInteger(options.pidsLimit, 'pidsLimit');
  assertPositiveInteger(options.maxFileBytes, 'maxFileBytes');
  assertCpus(options.cpus);
  assertSize(options.memory, 'memory');
  assertSize(options.tmpfsSize, 'tmpfsSize');
  assertUser(user);

  const env: Record<(typeof CONTAINER_ENV_NAMES)[number], string> = {
    openout_any: 'p',
    shell_escape: 'f',
    // Líneas del log sin cortar: las rutas de los archivos quedan enteras para los diagnósticos.
    max_print_line: '10000',
    HOME: '/tmp',
    LATEXWEB_TIMEOUT: String(options.timeoutSeconds),
  };

  return [
    'run',
    '--rm',
    '--name', name,
    '--label', `latexweb.compile=${compilationId}`,
    '--init',
    // Aislamiento y límites
    '--network', 'none',
    '--cpus', String(options.cpus),
    '--memory', options.memory,
    '--memory-swap', options.memory,
    '--pids-limit', String(options.pidsLimit),
    '--ulimit', `fsize=${options.maxFileBytes}`,
    '--read-only',
    // noexec explícito (Docker ya lo pone por defecto, pero no dependemos de eso). biber no
    // necesita ejecutar desde /tmp: está descomprimido en la imagen.
    '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${options.tmpfsSize}`,
    // Sin uid/gid/mode Docker monta /work como root 755 y el usuario no podría escribir.
    '--tmpfs', `/work:rw,nosuid,nodev,noexec,size=${options.tmpfsSize},uid=${user.uid},gid=${user.gid},mode=0700`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', `${user.uid}:${user.gid}`,
    // Entorno: solo la lista blanca, con valor explícito
    ...CONTAINER_ENV_NAMES.flatMap((key) => ['--env', `${key}=${env[key]}`]),
    // Montajes: exactamente dos, /in de solo lectura. --mount y no -v, que confunde la `C:` de las
    // rutas de Windows.
    ...mountArgs(compilationId, inputDir, outputDir, options.storageVolume),
    image,
    // Argumentos del script de entrada (latexweb-compile.sh), que solo acepta exactamente estos
    '-norc',
    '-no-shell-escape',
    '-interaction=nonstopmode',
    '-file-line-error',
    '-synctex=1',
    '-jobname=output',
    ENGINE_FLAGS[engine],
    mainFile,
  ];
}

function mountArgs(id: string, inputDir: string, outputDir: string, volume: string | undefined): string[] {
  if (volume === undefined) {
    return [
      '--mount', `type=bind,source=${inputDir},target=/in,readonly`,
      '--mount', `type=bind,source=${outputDir},target=/out`,
    ];
  }
  // Los subpaths salen solo del id ya validado como uuid. Docker además rechaza escapar del
  // volumen con `..`, rutas absolutas o symlinks (verificado en Docker 29.5.3).
  return [
    '--mount', `type=volume,source=${volume},target=/in,volume-subpath=${id}/input,readonly`,
    '--mount', `type=volume,source=${volume},target=/out,volume-subpath=${id}/out`,
  ];
}

// Nombre de volumen de Docker. Sin `,`, `=` ni `/`, que cambiarían el significado de --mount.
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function assertVolumeName(volume: string): void {
  if (!VOLUME_NAME.test(volume)) throw new DockerArgsError(`nombre de volumen inválido: ${volume}`);
}

export class DockerArgsError extends Error {
  override name = 'DockerArgsError';
}

function assertCompilationId(id: string): void {
  if (!isCompilationId(id)) throw new DockerArgsError(`id de compilación inválido: ${id}`);
}

// Referencia de imagen: repositorio[:tag][@digest]. Nunca empieza con `-` (se tomaría como opción).
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$/;

function assertImage(image: string): void {
  if (!IMAGE_REFERENCE.test(image)) throw new DockerArgsError(`imagen inválida: ${image}`);
}

// --mount es una lista separada por comas (con comillas al estilo CSV): una `,` o una `"` en la
// ruta cambiaría el significado del montaje.
const UNSAFE_MOUNT_CHARACTERS = /[,"\p{Cc}]/u;

/** Una ruta se puede usar como `source` de --mount: absoluta y sin `,`, `"` ni caracteres de control. */
export function isSafeMountSource(path: string): boolean {
  return isAbsolute(path) && !UNSAFE_MOUNT_CHARACTERS.test(path);
}

function assertMountSource(path: string, label: string): void {
  if (!isAbsolute(path)) throw new DockerArgsError(`${label} debe ser una ruta absoluta: ${path}`);
  if (!isSafeMountSource(path)) {
    throw new DockerArgsError(`${label} contiene caracteres no permitidos en --mount: ${path}`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new DockerArgsError(`${label} inválido: ${value}`);
}

function assertCpus(value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new DockerArgsError(`cpus inválido: ${value}`);
}

const SIZE = /^[1-9][0-9]*[kmg]$/;

function assertSize(value: string, label: string): void {
  if (!SIZE.test(value)) throw new DockerArgsError(`${label} inválido: ${value} (ej.: 256m, 1g)`);
}

function assertUser({ uid, gid }: Readonly<ContainerUser>): void {
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) {
    throw new DockerArgsError(`usuario inválido: ${uid}:${gid} (nunca root)`);
  }
}

// --- Ejecución y clasificación ---

export interface RunContainerOptions {
  /** Argumentos de `docker run` (ver buildDockerRunArgs). */
  args: readonly string[];
  /** Nombre del contenedor (ver containerName), para `docker rm -f` y `docker kill`. */
  containerName: string;
  /** El mismo timeout que recibe el contenedor (LATEXWEB_TIMEOUT). */
  timeoutSeconds: number;
  /** Margen sobre timeoutSeconds antes de que el worker mate el contenedor. */
  killGraceMs?: number;
  /** Ejecutable de docker; inyectable para tests. */
  dockerBin?: string;
}

export interface RunContainerResult {
  /** Código de salida de `docker run` (el del contenedor, o 125-127 si falla docker); null si murió por señal. */
  exitCode: number | null;
  /** El worker tuvo que matar el contenedor (el timeout interno no alcanzó). */
  killedByWorker: boolean;
  durationMs: number;
  /** Final de stderr de docker y del contenedor, para diagnosticar fallos de infraestructura. */
  stderrTail: string;
}

export const DEFAULT_KILL_GRACE_MS = 15_000;
const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * Corre `docker run` y espera a que termine. Antes borra un contenedor homónimo que pudo quedar
 * de un intento anterior. Si el contenedor no termina en `timeoutSeconds + killGraceMs`, lo mata
 * con `docker kill` (matar solo el proceso de la CLI no detiene el contenedor).
 */
export async function runContainer(options: RunContainerOptions): Promise<RunContainerResult> {
  const docker = options.dockerBin ?? 'docker';
  const killAfterMs = options.timeoutSeconds * 1000 + (options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);

  await runDocker(docker, ['rm', '-f', options.containerName]);

  const startedAt = Date.now();
  const child = spawn(docker, options.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

  let stderr = Buffer.alloc(0);
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES);
  });

  let killedByWorker = false;
  const killer = setTimeout(() => {
    killedByWorker = true;
    // En paralelo: matar la CLI no detiene el contenedor, y esperar a `docker kill` dejaría la
    // ranura ocupada si el daemon no responde.
    void runDocker(docker, ['kill', options.containerName]);
    child.kill();
  }, killAfterMs);

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); // p. ej. ENOENT: docker no está instalado
      child.once('close', (code) => resolve(code));
    });
    return {
      exitCode,
      killedByWorker,
      durationMs: Date.now() - startedAt,
      stderrTail: stderr.toString('utf8'),
    };
  } finally {
    clearTimeout(killer);
    // Con --rm docker borra el contenedor al terminar, pero si lo matamos o la CLI murió
    // antes, puede quedar: se fuerza el borrado (idempotente).
    if (killedByWorker) await runDocker(docker, ['rm', '-f', options.containerName]);
  }
}

/** Códigos de salida que indican un fallo de docker o del script de entrada, no de LaTeX. */
const INFRASTRUCTURE_EXIT_CODES = new Set([
  2, // latexweb-compile.sh rechazó los argumentos: bug del worker
  125, // docker no pudo crear o arrancar el contenedor (imagen ausente, flag inválido…)
  126, // el comando del contenedor no se pudo ejecutar
  127, // el comando del contenedor no existe
]);
/** `timeout` dentro del contenedor agotó LATEXWEB_TIMEOUT. */
const TIMEOUT_EXIT_CODE = 124;

export type RunClassification =
  | { kind: 'outcome'; outcome: CompileOutcome }
  | { kind: 'infrastructure'; reason: string };

/**
 * Traduce el resultado de la ejecución al resultado de la compilación. Un error de LaTeX es un
 * resultado (`error`), no una excepción; solo los fallos de infraestructura se informan aparte.
 * `hasPdf` es si se publicó un PDF (ver Workspace.publishArtifacts).
 */
export function classifyRun(run: Pick<RunContainerResult, 'exitCode' | 'killedByWorker'>, hasPdf: boolean): RunClassification {
  if (run.killedByWorker || run.exitCode === TIMEOUT_EXIT_CODE) return { kind: 'outcome', outcome: 'timeout' };
  if (run.exitCode === null) return { kind: 'infrastructure', reason: 'docker terminó por una señal' };
  if (INFRASTRUCTURE_EXIT_CODES.has(run.exitCode)) {
    return { kind: 'infrastructure', reason: `docker run terminó con el código ${run.exitCode}` };
  }
  if (run.exitCode === 0 && hasPdf) return { kind: 'outcome', outcome: 'success' };
  // Cualquier otro código (12 = error de LaTeX, 137 = SIGKILL, p. ej. por memoria) o 0 sin PDF.
  return { kind: 'outcome', outcome: 'error' };
}

/** Tope para los subcomandos auxiliares: si el daemon se cuelga, no bloquean la ranura del worker. */
export const AUX_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Ejecuta un subcomando de docker auxiliar e ignora su resultado (rm/kill son idempotentes). Si no
 * termina en `timeoutMs`, mata la CLI y sigue.
 */
export function runDocker(docker: string, args: string[], timeoutMs: number = AUX_COMMAND_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(docker, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('error', done);
    child.once('close', done);
  });
}

// --- Comprobación al arrancar ---

export type DockerCheck = { ok: true } | { ok: false; message: string };

/**
 * Versión mínima de la API de Docker para el modo volumen: `volume-subpath` existe desde la API
 * 1.45 (Docker 26). Un daemon más viejo podría ignorar el subpath y montar el volumen entero, con
 * lo que una compilación vería los proyectos de las demás.
 */
export const MIN_API_FOR_VOLUME_SUBPATH = '1.45';

export interface DockerCheckOptions {
  dockerBin?: string;
  /** Si se indica, falla cuando la API del daemon es menor. */
  minApiVersion?: string | undefined;
}

export async function checkDocker(image: string, options: DockerCheckOptions = {}): Promise<DockerCheck> {
  const dockerBin = options.dockerBin ?? 'docker';
  const version = await exec(dockerBin, ['version', '--format', '{{.Server.APIVersion}}']);
  if (version.code !== 0) {
    return {
      ok: false,
      message:
        'Docker no responde (¿Docker Desktop está apagado?). El worker necesita Docker para compilar.' +
        (version.output ? `\n${version.output}` : ''),
    };
  }
  if (options.minApiVersion !== undefined && compareApiVersions(version.output, options.minApiVersion) < 0) {
    return {
      ok: false,
      message: `La API de Docker del daemon (${version.output || 'desconocida'}) es anterior a ${options.minApiVersion}, necesaria para volume-subpath. Actualizar Docker Engine a 26 o posterior.`,
    };
  }
  const inspect = await exec(dockerBin, ['image', 'inspect', '--format', '{{.Id}}', image]);
  if (inspect.code !== 0) {
    return {
      ok: false,
      message: `Falta la imagen de compilación "${image}". Construirla con: pnpm --filter @latexweb/compiler image:build`,
    };
  }
  return { ok: true };
}

/** Compara versiones "1.45" numéricamente; una versión ilegible cuenta como la más vieja. */
export function compareApiVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+\.\d+$/.test(v.trim()) ? v.trim().split('.').map(Number) : [0, 0]);
  const [aMajor = 0, aMinor = 0] = parse(a);
  const [bMajor = 0, bMinor = 0] = parse(b);
  return aMajor !== bMajor ? aMajor - bMajor : aMinor - bMinor;
}

function exec(bin: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      // spawn puede lanzar de forma síncrona (p. ej. EINVAL en Windows): no hay que propagarlo.
      resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.once('error', (error) => resolve({ code: null, output: error.message }));
    child.once('close', (code) => resolve({ code, output: output.trim().slice(-500) }));
  });
}
