// Docker del worker sin Docker: los argumentos son una función pura y, para ejecutar, node
// (process.execPath) hace de docker falso. Lo que importa es el sandbox: sin red, sin shell-escape,
// con límites, montajes acotados y sin inyección de argumentos.
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDockerRunArgs,
  checkDocker,
  classifyRun,
  CONTAINER_ENV_NAMES,
  compareApiVersions,
  DockerArgsError,
  resolveContainerUser,
  runContainer,
  type DockerRunOptions,
} from '../src/docker';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const INPUT_DIR = path.join(os.tmpdir(), 'latexweb', ID, 'input');
const OUTPUT_DIR = path.join(os.tmpdir(), 'latexweb', ID, 'output');
const IMAGE = 'latexweb-texlive:tl2026-2';

function build(overrides: Partial<DockerRunOptions> = {}): string[] {
  return buildDockerRunArgs({
    compilationId: ID,
    image: IMAGE,
    engine: 'pdflatex',
    mainFile: 'main.tex',
    inputDir: INPUT_DIR,
    outputDir: OUTPUT_DIR,
    timeoutSeconds: 60,
    cpus: 1.5,
    memory: '1g',
    pidsLimit: 256,
    tmpfsSize: '256m',
    maxFileBytes: 52428801,
    user: { uid: 1001, gid: 1002 },
    ...overrides,
  });
}

/** Valores que siguen a cada aparición de `flag`. */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag && i + 1 < args.length ? [args[i + 1] as string] : []));
}

describe('argumentos de docker run', () => {
  it('aísla: sin red, sin capacidades, raíz de solo lectura y con límites', () => {
    const args = build({ cpus: 0.5, memory: '2g', pidsLimit: 128, maxFileBytes: 12345 });
    expect(args[0]).toBe('run');
    for (const flag of ['--read-only', '--init', '--rm']) expect(args).toContain(flag);
    expect(valuesOf(args, '--network')).toEqual(['none']);
    expect(valuesOf(args, '--cap-drop')).toEqual(['ALL']);
    expect(valuesOf(args, '--security-opt')).toContain('no-new-privileges');
    expect(valuesOf(args, '--cpus')).toEqual(['0.5']);
    expect(valuesOf(args, '--memory')).toEqual(['2g']);
    expect(valuesOf(args, '--memory-swap')).toEqual(['2g']);
    expect(valuesOf(args, '--pids-limit')).toEqual(['128']);
    expect(valuesOf(args, '--ulimit')).toEqual(['fsize=12345']);
    expect(valuesOf(args, '--user')).toEqual(['1001:1002']);
    for (const target of ['/tmp', '/work']) {
      const tmpfs = valuesOf(args, '--tmpfs').find((v) => v.startsWith(`${target}:`)) ?? '';
      expect(tmpfs.split(/[:,]/)).toEqual(expect.arrayContaining(['noexec', 'nosuid', 'nodev', 'size=256m']));
    }
  });

  it('nunca habilita shell-escape', () => {
    const args = build();
    expect(args).toContain('-no-shell-escape');
    expect(args).toContain('-norc');
    expect(valuesOf(args, '--env')).toContain('shell_escape=f');
    const others = args.filter(
      (arg) => /shell[-_]?escape|shell-restricted/i.test(arg) && arg !== '-no-shell-escape' && arg !== 'shell_escape=f',
    );
    expect(others).toEqual([]);
  });

  it('el entorno del contenedor es solo la lista blanca, con valores explícitos', () => {
    const env = valuesOf(build({ timeoutSeconds: 90 }), '--env');
    expect(env.map((v) => v.slice(0, v.indexOf('='))).sort()).toEqual([...CONTAINER_ENV_NAMES].sort());
    expect(env).toContain('LATEXWEB_TIMEOUT=90');
    expect(build()).not.toContain('--env-file');
    expect(build()).not.toContain('-e');
  });

  it('monta solo /in (solo lectura) y /out', () => {
    expect(valuesOf(build(), '--mount')).toEqual([
      `type=bind,source=${INPUT_DIR},target=/in,readonly`,
      `type=bind,source=${OUTPUT_DIR},target=/out`,
    ]);
    expect(build()).not.toContain('-v');
  });

  it('en modo volumen monta la subcarpeta de la compilación y nada más', () => {
    expect(valuesOf(build({ storageVolume: 'latexweb-compile-storage' }), '--mount')).toEqual([
      `type=volume,source=latexweb-compile-storage,target=/in,volume-subpath=${ID}/input,readonly`,
      `type=volume,source=latexweb-compile-storage,target=/out,volume-subpath=${ID}/out`,
    ]);
  });

  it('la imagen, las opciones de latexmk, el motor y mainFile van al final', () => {
    const args = build({ engine: 'xelatex', mainFile: 'docs/tesis.tex' });
    expect(args.slice(args.indexOf(IMAGE) + 1)).toEqual([
      '-norc',
      '-no-shell-escape',
      '-interaction=nonstopmode',
      '-file-line-error',
      '-synctex=1',
      '-jobname=output',
      '-pdfxe',
      'docs/tesis.tex',
    ]);
  });

  it.each<[string, Partial<DockerRunOptions>]>([
    ['compilationId con ../', { compilationId: `${ID}/../x` }],
    ['mainFile con $()', { mainFile: 'a$(id).tex' }],
    ['mainFile que parece una opción', { mainFile: '-e.tex' }],
    ['mainFile fuera del proyecto', { mainFile: '../main.tex' }],
    ['imagen que parece una opción', { image: '--privileged' }],
    ['inputDir con coma (rompe --mount)', { inputDir: path.join(os.tmpdir(), 'a,b') }],
    ['outputDir relativo', { outputDir: 'relative/out' }],
    ['volumen con coma', { storageVolume: 'a,b' }],
    ['usuario root', { user: { uid: 0, gid: 1000 } }],
    ['memoria inválida', { memory: '1 g' }],
    ['timeout no entero', { timeoutSeconds: 1.5 }],
  ])('rechaza %s', (_label, overrides) => {
    expect(() => build(overrides)).toThrow(DockerArgsError);
  });

  it('el usuario del contenedor nunca es root', () => {
    expect(resolveContainerUser(() => 0, () => 0)).toEqual({ uid: 10001, gid: 10001 });
    expect(resolveContainerUser(undefined, undefined)).toEqual({ uid: 10001, gid: 10001 });
    expect(resolveContainerUser(() => 1001, () => 1002)).toEqual({ uid: 1001, gid: 1002 });
  });
});

describe('classifyRun', () => {
  it.each<[string, number | null, boolean, boolean, string]>([
    ['0 con PDF', 0, false, true, 'success'],
    ['0 sin PDF', 0, false, false, 'error'],
    ['12 (error de LaTeX)', 12, false, true, 'error'],
    ['137 (memoria)', 137, false, false, 'error'],
    ['124 (timeout interno)', 124, false, false, 'timeout'],
    ['matado por el worker', null, true, false, 'timeout'],
  ])('%s → %s', (_label, exitCode, killedByWorker, hasPdf, outcome) => {
    expect(classifyRun({ exitCode, killedByWorker }, hasPdf)).toEqual({ kind: 'outcome', outcome });
  });

  it.each([2, 125, 126, 127, null])('código %s es un fallo de infraestructura', (exitCode) => {
    expect(classifyRun({ exitCode, killedByWorker: false }, true).kind).toBe('infrastructure');
  });
});

describe('runContainer (docker falso = node)', () => {
  const base = { dockerBin: process.execPath, timeoutSeconds: 30 };

  it('devuelve el código de salida y el final de stderr', async () => {
    const run = await runContainer({
      ...base,
      containerName: 'fake-exit',
      args: ['-e', 'process.stderr.write("x".repeat(20000) + "FIN"); process.exit(12)'],
    });
    expect(run.exitCode).toBe(12);
    expect(run.stderrTail.endsWith('FIN')).toBe(true);
    expect(Buffer.byteLength(run.stderrTail)).toBeLessThanOrEqual(8 * 1024);
  }, 20_000);

  it('mata el contenedor si excede el timeout más el margen', async () => {
    const run = await runContainer({
      ...base,
      timeoutSeconds: 0,
      killGraceMs: 300,
      containerName: 'fake-kill',
      args: ['-e', 'setTimeout(() => {}, 60000)'],
    });
    expect(run.killedByWorker).toBe(true);
    expect(run.durationMs).toBeLessThan(10_000);
  }, 20_000);
});

describe('checkDocker', () => {
  it('sin docker devuelve ok: false con un mensaje, sin lanzar', async () => {
    const result = await checkDocker('img:1', { dockerBin: path.join(os.tmpdir(), 'no-existe-docker') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Docker/);
  });

  it.each([
    ['1.54', '1.45', 1],
    ['1.45', '1.45', 0],
    ['1.9', '1.10', -1],
    ['basura', '1.45', -1],
  ])('compareApiVersions(%s, %s) tiene signo %i', (a, b, sign) => {
    expect(Math.sign(compareApiVersions(a, b))).toBe(sign);
  });
});
