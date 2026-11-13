// Comprobación al arrancar: Docker responde y la imagen de compilación existe.
import { spawn } from 'node:child_process';

export type DockerCheck = { ok: true } | { ok: false; message: string };

export async function checkDocker(image: string, dockerBin = 'docker'): Promise<DockerCheck> {
  const version = await exec(dockerBin, ['version', '--format', '{{.Server.Version}}']);
  if (version.code !== 0) {
    return {
      ok: false,
      message:
        'Docker no responde (¿Docker Desktop está apagado?). El worker necesita Docker para compilar.' +
        (version.output ? `\n${version.output}` : ''),
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
