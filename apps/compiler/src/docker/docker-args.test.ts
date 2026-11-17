import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDockerRunArgs,
  CONTAINER_ENV_NAMES,
  containerName,
  DockerArgsError,
  ENGINE_FLAGS,
  FALLBACK_CONTAINER_USER,
  resolveContainerUser,
  type DockerRunOptions,
} from './docker-args';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const INPUT_DIR = path.join(os.tmpdir(), 'latexweb', ID, 'input');
const OUTPUT_DIR = path.join(os.tmpdir(), 'latexweb', ID, 'output');
const USER = { uid: 1001, gid: 1002 };

function makeOptions(overrides: Partial<DockerRunOptions> = {}): DockerRunOptions {
  return {
    compilationId: ID,
    image: 'latexweb-texlive:tl2026-2',
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
    user: USER,
    ...overrides,
  };
}

function build(overrides: Partial<DockerRunOptions> = {}): string[] {
  return buildDockerRunArgs(makeOptions(overrides));
}

/** Valores que siguen a cada aparición de `flag`. */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag && i + 1 < args.length ? [args[i + 1] as string] : []));
}

function expectPair(args: string[], flag: string, value: string): void {
  const found = args.some((arg, i) => arg === flag && args[i + 1] === value);
  expect(found, `falta el par ${flag} ${value}`).toBe(true);
}

function throwsDockerArgsError(overrides: Partial<DockerRunOptions>): void {
  expect(() => build(overrides)).toThrow(DockerArgsError);
}

describe('aislamiento y límites', () => {
  it.each([
    ['--network', 'none'],
    ['--cap-drop', 'ALL'],
    ['--security-opt', 'no-new-privileges'],
  ])('incluye el par %s %s', (flag, value) => {
    expectPair(build(), flag, value);
  });

  it.each(['--read-only', '--init', '--rm'])('incluye %s', (flag) => {
    expect(build()).toContain(flag);
  });

  it('pasa cpus, memory, memory-swap y pids-limit', () => {
    const args = build({ cpus: 0.5, memory: '2g', pidsLimit: 128 });
    expectPair(args, '--cpus', '0.5');
    expectPair(args, '--memory', '2g');
    expectPair(args, '--memory-swap', '2g');
    expectPair(args, '--pids-limit', '128');
  });

  it('memory-swap es igual a memory', () => {
    const args = build({ memory: '512m' });
    expect(valuesOf(args, '--memory-swap')).toEqual(valuesOf(args, '--memory'));
  });

  it('empieza con run', () => {
    expect(build()[0]).toBe('run');
  });
});

describe('shell-escape', () => {
  it.each(['-norc', '-no-shell-escape'])('incluye %s', (flag) => {
    expect(build()).toContain(flag);
  });

  it('ningún otro argumento menciona shell-escape o shell-restricted', () => {
    const offenders = build().filter(
      (arg) => /shell[-_]?escape|shell-restricted/i.test(arg) && arg !== '-no-shell-escape' && arg !== 'shell_escape=f',
    );
    expect(offenders).toEqual([]);
  });

  it('shell_escape=f va como --env', () => {
    expect(valuesOf(build(), '--env')).toContain('shell_escape=f');
  });
});

describe('entorno', () => {
  it('cada valor tras --env tiene la forma NOMBRE=valor no vacío', () => {
    const values = valuesOf(build(), '--env');
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=.+$/);
  });

  it('solo usa nombres de CONTAINER_ENV_NAMES y aparecen todos', () => {
    const names = valuesOf(build(), '--env').map((v) => v.slice(0, v.indexOf('=')));
    expect([...names].sort()).toEqual([...CONTAINER_ENV_NAMES].sort());
  });

  it.each([1, 60, 900])('LATEXWEB_TIMEOUT es igual a timeoutSeconds (%i)', (timeoutSeconds) => {
    expect(valuesOf(build({ timeoutSeconds }), '--env')).toContain(`LATEXWEB_TIMEOUT=${timeoutSeconds}`);
  });

  it.each(['--env-file', '-e'])('no aparece %s', (flag) => {
    expect(build()).not.toContain(flag);
  });
});

describe('montajes', () => {
  it('hay exactamente dos --mount con los valores esperados', () => {
    expect(valuesOf(build(), '--mount')).toEqual([
      `type=bind,source=${INPUT_DIR},target=/in,readonly`,
      `type=bind,source=${OUTPUT_DIR},target=/out`,
    ]);
  });

  it.each(['-v', '--volume'])('no aparece %s', (flag) => {
    expect(build()).not.toContain(flag);
  });

  it.each([
    ['ruta relativa', 'relative/input'],
    ['coma', path.join(os.tmpdir(), 'a,b')],
    ['comilla doble', path.join(os.tmpdir(), 'a"b')],
    ['salto de línea', path.join(os.tmpdir(), 'a\nb')],
  ])('rechaza inputDir con %s', (_label, inputDir) => {
    throwsDockerArgsError({ inputDir });
  });

  it.each([
    ['ruta relativa', 'relative/output'],
    ['coma', path.join(os.tmpdir(), 'a,b')],
    ['comilla doble', path.join(os.tmpdir(), 'a"b')],
    ['salto de línea', path.join(os.tmpdir(), 'a\nb')],
  ])('rechaza outputDir con %s', (_label, outputDir) => {
    throwsDockerArgsError({ outputDir });
  });
});

describe('modo volumen (storageVolume)', () => {
  const VOLUME = 'latexweb-compile-storage';
  const withoutMounts = (args: string[]): string[] =>
    args.filter((arg, i) => arg !== '--mount' && args[i - 1] !== '--mount');

  it('hay exactamente dos --mount de tipo volume con subpath del id', () => {
    const args = build({ storageVolume: VOLUME });
    expect(valuesOf(args, '--mount')).toEqual([
      `type=volume,source=${VOLUME},target=/in,volume-subpath=${ID}/input,readonly`,
      `type=volume,source=${VOLUME},target=/out,volume-subpath=${ID}/out`,
    ]);
  });

  it('/in es de solo lectura y /out no', () => {
    const [input, output] = valuesOf(build({ storageVolume: VOLUME }), '--mount') as [string, string];
    expect(input.split(',')).toContain('readonly');
    expect(output.split(',')).not.toContain('readonly');
  });

  it('no aparece type=bind ni las rutas inputDir/outputDir', () => {
    const args = build({ storageVolume: VOLUME });
    expect(args.some((arg) => arg.includes('type=bind'))).toBe(false);
    expect(args.some((arg) => arg.includes(INPUT_DIR) || arg.includes(OUTPUT_DIR))).toBe(false);
  });

  it('los subpaths usan exactamente el compilationId', () => {
    const other = '223e4567-e89b-42d3-a456-426614174000';
    const mounts = valuesOf(build({ storageVolume: VOLUME, compilationId: other }), '--mount');
    expect(mounts.map((m) => /volume-subpath=([^,]*)/.exec(m)?.[1])).toEqual([`${other}/input`, `${other}/out`]);
  });

  it('los demás flags son idénticos a los del modo bind', () => {
    expect(withoutMounts(build({ storageVolume: VOLUME }))).toEqual(withoutMounts(build()));
  });

  it('el orden final no cambia: imagen, opciones, motor y mainFile al final', () => {
    const args = build({ storageVolume: VOLUME, engine: 'xelatex', mainFile: 'docs/tesis.tex' });
    const imageIndex = args.indexOf('latexweb-texlive:tl2026-2');
    expect(args.slice(imageIndex + 1)).toEqual([
      '-norc',
      '-no-shell-escape',
      '-interaction=nonstopmode',
      '-file-line-error',
      '-jobname=output',
      '-pdfxe',
      'docs/tesis.tex',
    ]);
    expect(args[imageIndex - 2]).toBe('--mount');
    expect(args[imageIndex - 1]).toBe(`type=volume,source=${VOLUME},target=/out,volume-subpath=${ID}/out`);
  });

  it.each(['', '-vol', 'a,b', 'a=b', 'a/b', 'a b', '"a"', '.vol', 'a\nb', '\n'])(
    'rechaza el nombre de volumen %j',
    (storageVolume) => {
      throwsDockerArgsError({ storageVolume });
    },
  );

  it.each(['latexweb-compile-storage', 'vol_1', 'v.2'])('acepta el nombre de volumen %s', (storageVolume) => {
    expect(valuesOf(build({ storageVolume }), '--mount')[0]).toContain(`source=${storageVolume},`);
  });

  it('storageVolume undefined equivale a no pasar la opción', () => {
    expect(build({ storageVolume: undefined })).toEqual(build());
  });
});

describe('tmpfs y usuario del contenedor', () => {
  const tmpfs = (args: string[], target: string): string => {
    const found = valuesOf(args, '--tmpfs').find((v) => v.startsWith(`${target}:`));
    expect(found, `falta tmpfs ${target}`).toBeDefined();
    return found as string;
  };

  it('/tmp lleva noexec, nosuid y nodev explícitos (no depende del default de Docker)', () => {
    const options = tmpfs(build(), '/tmp').split(/[:,]/);
    expect(options).toContain('noexec');
    expect(options).toContain('nosuid');
    expect(options).toContain('nodev');
  });

  it('FALLBACK_CONTAINER_USER está congelado', () => {
    expect(Object.isFrozen(FALLBACK_CONTAINER_USER)).toBe(true);
  });

  it('los tmpfs usan tmpfsSize', () => {
    const args = build({ tmpfsSize: '128m' });
    expect(tmpfs(args, '/tmp')).toContain('size=128m');
    expect(tmpfs(args, '/work')).toContain('size=128m');
  });

  it('/work lleva noexec, uid, gid y mode=0700', () => {
    const options = tmpfs(build({ user: { uid: 2001, gid: 2002 } }), '/work').split(/[:,]/);
    expect(options).toContain('noexec');
    expect(options).toContain('uid=2001');
    expect(options).toContain('gid=2002');
    expect(options).toContain('mode=0700');
  });

  it('--user coincide con uid:gid', () => {
    expectPair(build({ user: { uid: 2001, gid: 2002 } }), '--user', '2001:2002');
  });
});

describe('resolveContainerUser', () => {
  it('sin getuid ni getgid (Windows) devuelve 10001:10001', () => {
    expect(resolveContainerUser(undefined, undefined)).toEqual({ uid: 10001, gid: 10001 });
  });

  it('sin solo uno de los dos devuelve 10001:10001', () => {
    expect(resolveContainerUser(undefined, () => 1002)).toEqual({ uid: 10001, gid: 10001 });
    expect(resolveContainerUser(() => 1001, undefined)).toEqual({ uid: 10001, gid: 10001 });
  });

  it.each([
    ['uid 0', 0, 1002],
    ['gid 0', 1001, 0],
    ['uid y gid 0', 0, 0],
  ])('con %s (root) devuelve 10001:10001', (_label, uid, gid) => {
    expect(resolveContainerUser(() => uid, () => gid)).toEqual({ uid: 10001, gid: 10001 });
  });

  it('con 1001/1002 devuelve esos valores', () => {
    expect(resolveContainerUser(() => 1001, () => 1002)).toEqual({ uid: 1001, gid: 1002 });
  });
});

describe('buildDockerRunArgs: usuario inválido', () => {
  it.each([
    ['uid 0', { uid: 0, gid: 1000 }],
    ['gid 0', { uid: 1000, gid: 0 }],
    ['uid negativo', { uid: -1, gid: 1000 }],
    ['gid negativo', { uid: 1000, gid: -5 }],
    ['uid no entero', { uid: 1000.5, gid: 1000 }],
    ['gid no entero', { uid: 1000, gid: 1.2 }],
    ['uid NaN', { uid: Number.NaN, gid: 1000 }],
  ])('rechaza %s', (_label, user) => {
    throwsDockerArgsError({ user });
  });
});

describe('orden de los argumentos', () => {
  it('la imagen va tras el último flag de docker y luego los argumentos del script', () => {
    const args = build();
    const imageIndex = args.indexOf('latexweb-texlive:tl2026-2');
    expect(imageIndex).toBeGreaterThan(0);
    expect(args.slice(imageIndex + 1)).toEqual([
      '-norc',
      '-no-shell-escape',
      '-interaction=nonstopmode',
      '-file-line-error',
      '-jobname=output',
      '-pdf',
      'main.tex',
    ]);
    // El elemento anterior a la imagen es el valor del último --mount
    expect(args[imageIndex - 2]).toBe('--mount');
    expect(args[imageIndex - 1]).toBe(`type=bind,source=${OUTPUT_DIR},target=/out`);
  });

  it('mainFile es el último argumento', () => {
    expect(build({ mainFile: 'docs/tesis.tex' }).at(-1)).toBe('docs/tesis.tex');
  });

  it('ENGINE_FLAGS tiene el flag de cada motor', () => {
    expect(ENGINE_FLAGS).toEqual({ pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' });
  });

  it.each([
    ['pdflatex', '-pdf'],
    ['xelatex', '-pdfxe'],
    ['lualatex', '-pdflua'],
  ] as const)('con %s usa %s justo antes de mainFile', (engine, flag) => {
    const args = build({ engine });
    expect(args.at(-2)).toBe(flag);
    expect(args.at(-1)).toBe('main.tex');
  });
});

describe('validaciones', () => {
  it.each([
    'no-es-uuid',
    '',
    '../x',
    ID.toUpperCase(),
    `${ID}/../x`,
  ])('rechaza compilationId %j', (compilationId) => {
    throwsDockerArgsError({ compilationId });
  });

  it('rechaza un motor inválido', () => {
    throwsDockerArgsError({ engine: 'latex' as never });
  });

  it.each(['-e.tex', 'a$(id).tex', '../main.tex', '', 'main.txt'])('rechaza mainFile %j', (mainFile) => {
    throwsDockerArgsError({ mainFile });
  });

  it.each([
    'latexweb-texlive:tl2026-2',
    'texlive/texlive:latest-full',
    `latexweb-texlive@sha256:${'a1'.repeat(32)}`,
    `latexweb-texlive:tl2026-2@sha256:${'0f'.repeat(32)}`,
  ])('acepta la imagen %s', (image) => {
    expect(build({ image })).toContain(image);
  });

  it.each([
    '-image',
    '--privileged',
    '',
    'my image',
    'img\n',
    `img@sha256:${'a'.repeat(63)}`,
    `img@sha256:${'A'.repeat(64)}`,
  ])('rechaza la imagen %j', (image) => {
    throwsDockerArgsError({ image });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rechaza timeoutSeconds %s', (timeoutSeconds) => {
    throwsDockerArgsError({ timeoutSeconds });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rechaza pidsLimit %s', (pidsLimit) => {
    throwsDockerArgsError({ pidsLimit });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rechaza cpus %s', (cpus) => {
    throwsDockerArgsError({ cpus });
  });

  it.each([0.5, 1, 2])('acepta cpus %s', (cpus) => {
    expectPair(build({ cpus }), '--cpus', String(cpus));
  });

  it.each(['1G', '0m', '256', '1 g', '', '-1m', '1.5g', '1gb'])('rechaza memory %j', (memory) => {
    throwsDockerArgsError({ memory });
  });

  it.each(['1G', '0m', '256', '1 g', '', '-1m', '1.5g', '1gb'])('rechaza tmpfsSize %j', (tmpfsSize) => {
    throwsDockerArgsError({ tmpfsSize });
  });

  it.each(['1g', '256m', '512k'])('acepta tamaño %s', (size) => {
    const args = build({ memory: size, tmpfsSize: size });
    expectPair(args, '--memory', size);
  });
});

describe('containerName', () => {
  it('devuelve latexweb-compile-<id>', () => {
    expect(containerName(ID)).toBe(`latexweb-compile-${ID}`);
  });

  it.each(['../x', 'x', '', ID.toUpperCase()])('lanza con el id inválido %j', (id) => {
    expect(() => containerName(id)).toThrow(DockerArgsError);
  });

  it('--name y --label usan el id', () => {
    const args = build();
    expectPair(args, '--name', `latexweb-compile-${ID}`);
    expectPair(args, '--label', `latexweb.compile=${ID}`);
  });
});

describe('inyección', () => {
  it.each(['main.tex', 'docs/capitulo-1.tex', 'a_b.c.tex'])(
    'con mainFile %s ningún argumento contiene ; | $ ni comillas invertidas',
    (mainFile) => {
      for (const engine of Object.keys(ENGINE_FLAGS) as (keyof typeof ENGINE_FLAGS)[]) {
        for (const arg of build({ mainFile, engine })) expect(arg).not.toMatch(/[;|$`]/);
      }
    },
  );

  it.each([';rm.tex', 'a|b.tex', 'a`id`.tex', '$HOME.tex', 'a b.tex'])(
    'rechaza mainFile peligroso %j',
    (mainFile) => {
      throwsDockerArgsError({ mainFile });
    },
  );
});

describe('--ulimit fsize (tope por archivo)', () => {
  it('pasa maxFileBytes como fsize en bytes', () => {
    expect(valuesOf(build({ maxFileBytes: 12345 }), '--ulimit')).toEqual(['fsize=12345']);
  });

  it.each([0, -1, 1.5, Number.NaN])('rechaza maxFileBytes %s', (maxFileBytes) => {
    throwsDockerArgsError({ maxFileBytes });
  });
});
