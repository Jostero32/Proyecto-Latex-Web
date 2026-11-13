// Argumentos de `docker run` para una compilación. Función pura: no ejecuta nada.
// Ver docs/specs/compilacion.md, sección "Ejecución en Docker". Los flags están verificados
// contra la imagen latexweb-texlive en el paso 2 de la spec.
import { isAbsolute } from 'node:path';
import { isCompilationId, isEngine, isValidMainFile, type Engine } from '@latexweb/shared';

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
export const CONTAINER_ENV_NAMES = ['openout_any', 'shell_escape', 'HOME', 'LATEXWEB_TIMEOUT'] as const;

/** Usuario del contenedor cuando no se puede usar el del worker (Windows, macOS sin getuid, o root). */
export const FALLBACK_CONTAINER_USER: Readonly<ContainerUser> = Object.freeze({ uid: 1000, gid: 1000 });

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
  user: Readonly<ContainerUser>;
}

/** Nombre del contenedor; permite `docker kill` / `docker rm -f` idempotentes por compilación. */
export function containerName(compilationId: string): string {
  assertCompilationId(compilationId);
  return `latexweb-compile-${compilationId}`;
}

/**
 * Usuario con el que corre el contenedor. En Linux, el uid/gid del worker, para que los
 * artefactos de /out le pertenezcan. Nunca root: si el worker corre como root (o la plataforma
 * no tiene getuid, como Windows) se usa 1000:1000 y el directorio de salida debe ser escribible
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
  assertPositiveInteger(options.timeoutSeconds, 'timeoutSeconds');
  assertPositiveInteger(options.pidsLimit, 'pidsLimit');
  assertCpus(options.cpus);
  assertSize(options.memory, 'memory');
  assertSize(options.tmpfsSize, 'tmpfsSize');
  assertUser(user);

  const env: Record<(typeof CONTAINER_ENV_NAMES)[number], string> = {
    openout_any: 'p',
    shell_escape: 'f',
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
    // Montajes: --mount y no -v, que confunde la `C:` de las rutas de Windows
    '--mount', `type=bind,source=${inputDir},target=/in,readonly`,
    '--mount', `type=bind,source=${outputDir},target=/out`,
    image,
    // Argumentos del script de entrada (latexweb-compile.sh), que solo acepta exactamente estos
    '-norc',
    '-no-shell-escape',
    '-interaction=nonstopmode',
    '-file-line-error',
    '-jobname=output',
    ENGINE_FLAGS[engine],
    mainFile,
  ];
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
