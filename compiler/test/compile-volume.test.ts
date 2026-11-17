// Integración del modo volumen (docker compose): las compilaciones montan su subcarpeta de un
// volumen con nombre (volume-subpath) en lugar de rutas del host. Ver docs/specs/docker-compose.md.
//
// El test corre en el host, así que no puede escribir en el volumen directamente: un contenedor
// auxiliar copia el fixture a <id>/input y lee después <id>/out. Corre con `pnpm test:compile`.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDockerRunArgs, classifyRun, containerName, runContainer } from '../src/docker';

const IMAGE = process.env.COMPILE_IMAGE ?? 'latexweb-texlive:tl2026-2';
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const CANARY = 'LATEXWEB_CANARY';

const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const dockerReady = docker(['info']).status === 0 && docker(['image', 'inspect', IMAGE]).status === 0;
if (!dockerReady) {
  throw new Error(`Docker no responde o falta la imagen ${IMAGE} (pnpm --filter @latexweb/compiler image:build)`);
}

describe('modo volumen con Docker real', () => {
  const volume = `latexweb-test-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    expect(docker(['volume', 'create', volume]).status).toBe(0);
    process.env[CANARY] = `secreto-${randomUUID()}`;
  });

  afterAll(() => {
    delete process.env[CANARY];
    docker(['volume', 'rm', '-f', volume]);
  });

  /** Ejecuta un comando de shell en un contenedor auxiliar con el volumen en /data. */
  function inVolume(script: string, extraMounts: string[] = []) {
    return docker(['run', '--rm', '-v', `${volume}:/data`, ...extraMounts, '--entrypoint', 'sh', IMAGE, '-c', script]);
  }

  async function compile(fixture: string) {
    const id = randomUUID();
    // Lo que harían server (input/) y prepareInputs del worker en contenedor (out/ del uid 1000).
    const prep = inVolume(
      `mkdir -p /data/${id}/input /data/${id}/out && cp -R /src/. /data/${id}/input/ && chown 10001:10001 /data/${id}/out`,
      ['--mount', `type=bind,source=${FIXTURES}${fixture},target=/src,readonly`],
    );
    expect(prep.status, prep.stderr).toBe(0);

    const run = await runContainer({
      containerName: containerName(id),
      timeoutSeconds: 60,
      args: buildDockerRunArgs({
        compilationId: id,
        image: IMAGE,
        engine: 'pdflatex',
        mainFile: 'main.tex',
        // En modo volumen no se montan; solo se validan como rutas absolutas.
        inputDir: `/data/compilations/${id}/input`,
        outputDir: `/data/compilations/${id}/out`,
        timeoutSeconds: 60,
        cpus: 1,
        memory: '1g',
        pidsLimit: 128,
        tmpfsSize: '256m',
        maxFileBytes: 52428801,
        user: { uid: 10001, gid: 10001 },
        storageVolume: volume,
      }),
    });
    const out = inVolume(`head -c 5 /data/${id}/out/output.pdf; echo; cat /data/${id}/out/output.log`);
    return { run, pdfHeader: out.stdout.split('\n')[0] ?? '', log: out.stdout };
  }

  it('compila articulo-simple montando /in y /out desde el volumen', async () => {
    const { run, pdfHeader, log } = await compile('articulo-simple');
    expect(classifyRun(run, pdfHeader === '%PDF-')).toEqual({ kind: 'outcome', outcome: 'success' });
    expect(log).toContain('Output written on output.pdf');
  }, 180_000);

  it('malicioso: los 5 intentos quedan bloqueados también en modo volumen', async () => {
    const { log } = await compile('malicioso');
    expect(log).toContain('LATEXWEB-SANDBOX: FIN');
    for (const key of ['shell-escape-nivel', 'write18-ejecucion', 'write18-etc-passwd', 'canario-entorno', 'latexmkrc-perl']) {
      expect(log).toContain(`LATEXWEB-SANDBOX: ${key}=BLOQUEADO`);
    }
    expect(log).not.toContain('=VULNERABLE');
  }, 180_000);

  // biber no consulta kpathsea: con un biber.conf del proyecto (output_directory=/out) escribía
  // directamente en /out, saltándose openout_any (verificado con la imagen tl2026-1). El script de
  // entrada quita el permiso de escritura de /out mientras compila.
  it('biber no puede escribir en /out aunque el proyecto traiga un biber.conf', async () => {
    const id = randomUUID();
    const conf = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <output_directory>/out</output_directory>\n</config>\n';
    const prep = docker([
      'run', '--rm', '-v', `${volume}:/data`, '--env', `CONF=${conf}`,
      '--mount', `type=bind,source=${FIXTURES}con-bibliografia,target=/src,readonly`,
      '--entrypoint', 'sh', IMAGE, '-c',
      `mkdir -p /data/${id}/input /data/${id}/out && cp -R /src/. /data/${id}/input/ && printf '%s' "$CONF" > /data/${id}/input/biber.conf && chown 10001:10001 /data/${id}/out`,
    ]);
    expect(prep.status, prep.stderr).toBe(0);

    await runContainer({
      containerName: containerName(id),
      timeoutSeconds: 60,
      args: buildDockerRunArgs({
        compilationId: id,
        image: IMAGE,
        engine: 'pdflatex',
        mainFile: 'main.tex',
        inputDir: `/data/compilations/${id}/input`,
        outputDir: `/data/compilations/${id}/out`,
        timeoutSeconds: 60,
        cpus: 1,
        memory: '1g',
        pidsLimit: 128,
        tmpfsSize: '256m',
        maxFileBytes: 52428801,
        user: { uid: 10001, gid: 10001 },
        storageVolume: volume,
      }),
    });
    const files = inVolume(`ls /data/${id}/out`).stdout.trim().split('\n').sort();
    // Solo los artefactos que copia el script al terminar; nada escrito por biber durante la compilación.
    expect(files.every((f) => f === 'output.pdf' || f === 'output.log')).toBe(true);
    expect(files).toContain('output.log');
  }, 180_000);

  // LuaTeX aplica openout_any también a io.open (verificado: pasa incluso sin el chmod de /out).
  // Regresión: que siga sin poder escribir en /out.
  it('lualatex no puede escribir en /out con io.open', async () => {
    const id = randomUUID();
    const doc = String.raw`\documentclass{article}
\begin{document}
\directlua{
  local f = io.open('/out/pwned-lua.txt', 'w')
  if f then f:write('PWNED') f:close() texio.write_nl('LATEXWEB-LUA: VULNERABLE')
  else texio.write_nl('LATEXWEB-LUA: BLOQUEADO') end
}
Hola.
\end{document}
`;
    const prep = docker([
      'run', '--rm', '-v', `${volume}:/data`, '--env', `DOC=${doc}`, '--entrypoint', 'sh', IMAGE, '-c',
      `mkdir -p /data/${id}/input /data/${id}/out && printf '%s' "$DOC" > /data/${id}/input/main.tex && chown 10001:10001 /data/${id}/out`,
    ]);
    expect(prep.status, prep.stderr).toBe(0);

    await runContainer({
      containerName: containerName(id),
      timeoutSeconds: 60,
      args: buildDockerRunArgs({
        compilationId: id,
        image: IMAGE,
        engine: 'lualatex',
        mainFile: 'main.tex',
        inputDir: `/data/compilations/${id}/input`,
        outputDir: `/data/compilations/${id}/out`,
        timeoutSeconds: 60,
        cpus: 1,
        memory: '1g',
        pidsLimit: 128,
        tmpfsSize: '256m',
        maxFileBytes: 52428801,
        user: { uid: 10001, gid: 10001 },
        storageVolume: volume,
      }),
    });
    const out = inVolume(`ls /data/${id}/out; grep 'LATEXWEB-LUA' /data/${id}/out/output.log`);
    expect(out.stdout).toContain('LATEXWEB-LUA: BLOQUEADO');
    expect(out.stdout).not.toContain('pwned-lua.txt');
    expect(out.stdout).toContain('output.pdf');
  }, 180_000);

  it('/in es de solo lectura dentro del contenedor de compilación', () => {
    const id = randomUUID();
    expect(inVolume(`mkdir -p /data/${id}/input`).status).toBe(0);
    const write = docker([
      'run', '--rm', '--user', '10001:10001',
      '--mount', `type=volume,source=${volume},target=/in,volume-subpath=${id}/input,readonly`,
      '--entrypoint', 'sh', IMAGE, '-c', 'touch /in/x',
    ]);
    expect(write.status).not.toBe(0);
    expect(write.stderr).toMatch(/Read-only file system/);
  }, 60_000);
});
