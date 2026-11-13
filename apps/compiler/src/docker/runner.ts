// Ejecuta el contenedor de compilación y clasifica el resultado.
// Ver docs/specs/compilacion.md, secciones "Ejecución en Docker" (timeout en dos niveles) y
// "Estados y resultado".
import { spawn } from 'node:child_process';
import type { CompileOutcome } from '@latexweb/shared';

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
    void runDocker(docker, ['kill', options.containerName]).finally(() => child.kill());
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

/** Ejecuta un subcomando de docker auxiliar e ignora su resultado (rm/kill son idempotentes). */
function runDocker(docker: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(docker, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}
