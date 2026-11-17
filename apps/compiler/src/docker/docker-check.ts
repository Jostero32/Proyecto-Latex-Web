// Comprobación al arrancar: Docker responde, la API alcanza la versión mínima y la imagen de
// compilación existe.
import { spawn } from 'node:child_process';

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
