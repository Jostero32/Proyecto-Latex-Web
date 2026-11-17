// Tests unitarios del processor sin Docker ni Redis: Workspace y runContainer falsos.
// Ver docs/specs/compilacion.md, "Estados y resultado" y paso 6.
import { describe, expect, it, vi } from 'vitest';
import type { RunContainerOptions, RunContainerResult } from '../docker/runner';
import type { PublishResult, Workspace } from '../workspace/workspace';
import { createCompileProcessor, InfrastructureError, InvalidJobError, parseJobData, type ProcessorDeps } from './processor';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const IMAGE = 'latexweb-texlive:test';
const GOOD = { compilationId: ID, engine: 'pdflatex', mainFile: 'main.tex' };

interface Harness {
  calls: string[];
  workspace: Workspace;
  deps: ProcessorDeps;
  prepareInputs: ReturnType<typeof vi.fn>;
  publishArtifacts: ReturnType<typeof vi.fn>;
  cleanupWork: ReturnType<typeof vi.fn>;
  runContainer: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
  processor: ReturnType<typeof createCompileProcessor>;
}

interface Setup {
  run?: Partial<RunContainerResult>;
  runRejects?: Error;
  publish?: Partial<PublishResult>;
  prepareRejects?: Error;
  cleanupRejects?: Error;
}

function setup(s: Setup = {}): Harness {
  const calls: string[] = [];
  const prepareInputs = vi.fn(async (id: string) => {
    calls.push(`prepareInputs:${id}`);
    if (s.prepareRejects) throw s.prepareRejects;
    return { inputDir: '/data/' + id + '/input', outputDir: '/data/' + id + '/out' };
  });
  const publishArtifacts = vi.fn(async (id: string): Promise<PublishResult> => {
    calls.push(`publishArtifacts:${id}`);
    return { hasPdf: true, pdfTooLarge: false, hasLog: true, logTruncated: false, ...s.publish };
  });
  const cleanupWork = vi.fn(async (id: string) => {
    calls.push(`cleanupWork:${id}`);
    if (s.cleanupRejects) throw s.cleanupRejects;
  });
  const runContainer = vi.fn(async (): Promise<RunContainerResult> => {
    calls.push('runContainer');
    if (s.runRejects) throw s.runRejects;
    return { exitCode: 0, killedByWorker: false, durationMs: 1234, stderrTail: '', ...s.run };
  });
  const logError = vi.fn();
  const workspace: Workspace = {
    prepareInputs,
    publishArtifacts,
    cleanupWork,
    sweepExpired: async () => ({ removed: [], failed: [] }),
  };
  const deps: ProcessorDeps = {
    workspace,
    containerUser: { uid: 1001, gid: 1002 },
    image: IMAGE,
    timeoutSeconds: 42,
    cpus: 1,
    memory: '1g',
    pidsLimit: 128,
    tmpfsSize: '256m',
    maxFileBytes: 52428801,
    runContainer,
    logError,
  };
  return { calls, workspace, deps, prepareInputs, publishArtifacts, cleanupWork, runContainer, logError, processor: createCompileProcessor(deps) };
}

const badPayloads: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['una cadena', 'texto'],
  ['un número', 42],
  ['compilationId no uuid', { ...GOOD, compilationId: 'no-es-uuid' }],
  ['compilationId ausente', { engine: 'pdflatex', mainFile: 'main.tex' }],
  ['compilationId numérico', { ...GOOD, compilationId: 5 }],
  ['motor inválido', { ...GOOD, engine: 'latex' }],
  ['motor ausente', { compilationId: ID, mainFile: 'main.tex' }],
  ['mainFile -e.tex', { ...GOOD, mainFile: '-e.tex' }],
  ['mainFile ../x.tex', { ...GOOD, mainFile: '../x.tex' }],
  ['mainFile no cadena', { ...GOOD, mainFile: 7 }],
];

describe('payload', () => {
  it('parseJobData acepta un payload válido', () => {
    expect(parseJobData(GOOD)).toEqual(GOOD);
  });

  it.each(badPayloads)('parseJobData rechaza %s', (_name, data) => {
    expect(() => parseJobData(data)).toThrow(InvalidJobError);
  });

  it.each(badPayloads)('el processor rechaza %s sin preparar ni ejecutar', async (_name, data) => {
    const h = setup();
    await expect(h.processor({ id: ID, data })).rejects.toThrow(InvalidJobError);
    expect(h.prepareInputs).not.toHaveBeenCalled();
    expect(h.runContainer).not.toHaveBeenCalled();
    expect(h.cleanupWork).not.toHaveBeenCalled();
  });
});

describe('id del job', () => {
  it('lanza InvalidJobError si job.id no coincide con compilationId', async () => {
    const h = setup();
    await expect(h.processor({ id: '223e4567-e89b-42d3-a456-426614174000', data: GOOD })).rejects.toThrow(InvalidJobError);
    expect(h.prepareInputs).not.toHaveBeenCalled();
    expect(h.runContainer).not.toHaveBeenCalled();
  });

  it('acepta un job sin id', async () => {
    const h = setup();
    await expect(h.processor({ data: GOOD })).resolves.toMatchObject({ outcome: 'success' });
  });
});

describe('éxito', () => {
  it('devuelve success y copia los campos', async () => {
    const h = setup({ run: { exitCode: 0, durationMs: 987 }, publish: { hasPdf: true, pdfTooLarge: false, hasLog: false } });
    const result = await h.processor({ id: ID, data: GOOD });
    expect(result).toEqual({ outcome: 'success', exitCode: 0, durationMs: 987, hasPdf: true, hasLog: false, pdfMissingReason: null });
  });

  it.each([
    ['pdflatex', '-pdf'],
    ['xelatex', '-pdfxe'],
    ['lualatex', '-pdflua'],
  ])('con %s pasa a runContainer los argumentos esperados (%s)', async (engine, flag) => {
    const h = setup();
    await h.processor({ id: ID, data: { ...GOOD, engine, mainFile: 'tesis.tex' } });

    expect(h.runContainer).toHaveBeenCalledTimes(1);
    const options = h.runContainer.mock.calls[0]![0] as RunContainerOptions;
    expect(options.containerName).toBe(`latexweb-compile-${ID}`);
    expect(options.timeoutSeconds).toBe(42);
    expect(options.args).toContain(IMAGE);
    expect(options.args.slice(-2)).toEqual([flag, 'tesis.tex']);
  });
});

describe('modo volumen', () => {
  async function mountsFor(storageVolume?: string): Promise<string[]> {
    const h = setup();
    const processor = createCompileProcessor({ ...h.deps, storageVolume });
    await processor({ id: ID, data: GOOD });
    const options = h.runContainer.mock.calls[0]![0] as RunContainerOptions;
    return options.args.flatMap((arg, i) => (arg === '--mount' ? [options.args[i + 1] as string] : []));
  }

  it('con storageVolume pasa montajes de volumen a runContainer', async () => {
    expect(await mountsFor('latexweb-compile-storage')).toEqual([
      `type=volume,source=latexweb-compile-storage,target=/in,volume-subpath=${ID}/input,readonly`,
      `type=volume,source=latexweb-compile-storage,target=/out,volume-subpath=${ID}/out`,
    ]);
  });

  it('sin storageVolume pasa montajes bind', async () => {
    expect(await mountsFor()).toEqual([
      `type=bind,source=/data/${ID}/input,target=/in,readonly`,
      `type=bind,source=/data/${ID}/out,target=/out`,
    ]);
  });
});

describe('resultados sin éxito', () => {
  it('PDF demasiado grande: error con too_large', async () => {
    const h = setup({ run: { exitCode: 0 }, publish: { hasPdf: false, pdfTooLarge: true } });
    const result = await h.processor({ id: ID, data: GOOD });
    expect(result).toMatchObject({ outcome: 'error', hasPdf: false, pdfMissingReason: 'too_large' });
  });

  it('error de LaTeX (exit 12 sin PDF): error con not_produced', async () => {
    const h = setup({ run: { exitCode: 12 }, publish: { hasPdf: false } });
    const result = await h.processor({ id: ID, data: GOOD });
    expect(result).toMatchObject({ outcome: 'error', exitCode: 12, hasPdf: false, hasLog: true, pdfMissingReason: 'not_produced' });
  });

  it('exit 0 sin PDF ni too_large: error con not_produced', async () => {
    const h = setup({ run: { exitCode: 0 }, publish: { hasPdf: false } });
    expect(await h.processor({ id: ID, data: GOOD })).toMatchObject({ outcome: 'error', pdfMissingReason: 'not_produced' });
  });

  it('exit 124: timeout', async () => {
    const h = setup({ run: { exitCode: 124 }, publish: { hasPdf: false } });
    expect(await h.processor({ id: ID, data: GOOD })).toMatchObject({ outcome: 'timeout', exitCode: 124 });
  });

  it('killedByWorker: timeout', async () => {
    const h = setup({ run: { exitCode: null, killedByWorker: true }, publish: { hasPdf: false } });
    expect(await h.processor({ id: ID, data: GOOD })).toMatchObject({ outcome: 'timeout', exitCode: null });
  });
});

describe('infraestructura', () => {
  it.each([
    ['exit 125', 125],
    ['exitCode null', null],
  ])('%s lanza InfrastructureError y registra id y stderrTail', async (_name, exitCode) => {
    const h = setup({ run: { exitCode, stderrTail: 'Unable to find image' }, publish: { hasPdf: false } });
    await expect(h.processor({ id: ID, data: GOOD })).rejects.toThrow(InfrastructureError);
    expect(h.logError).toHaveBeenCalledTimes(1);
    const message = String(h.logError.mock.calls[0]![0]);
    expect(message).toContain(ID);
    expect(message).toContain('Unable to find image');
  });

  it('si runContainer rechaza (ENOENT), la promesa se rechaza con ese error', async () => {
    const error = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    const h = setup({ runRejects: error });
    await expect(h.processor({ id: ID, data: GOOD })).rejects.toBe(error);
    expect(h.publishArtifacts).not.toHaveBeenCalled();
  });
});

describe('limpieza', () => {
  const scenarios: Array<[string, Setup]> = [
    ['éxito', {}],
    ['error de LaTeX', { run: { exitCode: 12 }, publish: { hasPdf: false } }],
    ['infraestructura', { run: { exitCode: 125 }, publish: { hasPdf: false } }],
    ['runContainer que rechaza', { runRejects: new Error('boom') }],
  ];

  it.each(scenarios)('cleanupWork se llama una vez con el id tras %s', async (_name, s) => {
    const h = setup(s);
    await h.processor({ id: ID, data: GOOD }).catch(() => undefined);
    expect(h.cleanupWork).toHaveBeenCalledTimes(1);
    expect(h.cleanupWork).toHaveBeenCalledWith(ID);
  });

  it('no se llama si prepareInputs falla, y el error se propaga', async () => {
    const error = new Error('sin input');
    const h = setup({ prepareRejects: error });
    await expect(h.processor({ id: ID, data: GOOD })).rejects.toBe(error);
    expect(h.cleanupWork).not.toHaveBeenCalled();
    expect(h.runContainer).not.toHaveBeenCalled();
  });

  it('si cleanupWork falla no tapa el resultado y se informa por logError', async () => {
    const h = setup({ cleanupRejects: new Error('EBUSY') });
    const result = await h.processor({ id: ID, data: GOOD });
    expect(result.outcome).toBe('success');
    expect(h.logError).toHaveBeenCalledTimes(1);
    const message = String(h.logError.mock.calls[0]![0]);
    expect(message).toContain(ID);
    expect(message).toContain('EBUSY');
  });

  it('si cleanupWork falla no tapa el error original', async () => {
    const original = new Error('boom');
    const h = setup({ runRejects: original, cleanupRejects: new Error('EBUSY') });
    await expect(h.processor({ id: ID, data: GOOD })).rejects.toBe(original);
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(String(h.logError.mock.calls[0]![0])).toContain('EBUSY');
  });

  it('no tapa un InfrastructureError cuando cleanupWork también falla', async () => {
    const h = setup({ run: { exitCode: 125 }, cleanupRejects: new Error('EBUSY') });
    await expect(h.processor({ id: ID, data: GOOD })).rejects.toThrow(InfrastructureError);
    expect(h.logError).toHaveBeenCalledTimes(2);
  });
});

describe('orden', () => {
  it('prepareInputs, runContainer, publishArtifacts y cleanupWork', async () => {
    const h = setup();
    await h.processor({ id: ID, data: GOOD });
    expect(h.calls).toEqual([`prepareInputs:${ID}`, 'runContainer', `publishArtifacts:${ID}`, `cleanupWork:${ID}`]);
  });
});

describe('piso de espacio libre', () => {
  it('con menos espacio que minFreeBytes falla como infraestructura sin preparar ni compilar', async () => {
    const h = setup();
    const processor = createCompileProcessor({ ...h.deps, minFreeBytes: 1000, freeBytes: async () => 999 });
    await expect(processor({ id: ID, data: GOOD })).rejects.toBeInstanceOf(InfrastructureError);
    expect(h.prepareInputs).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('runContainer');
    expect(h.logError).toHaveBeenCalled();
  });

  it('con espacio suficiente compila normalmente', async () => {
    const h = setup();
    const processor = createCompileProcessor({ ...h.deps, minFreeBytes: 1000, freeBytes: async () => 1000 });
    await expect(processor({ id: ID, data: GOOD })).resolves.toMatchObject({ outcome: 'success' });
  });

  it('sin minFreeBytes no consulta el espacio', async () => {
    const h = setup();
    const freeBytes = vi.fn(async () => 0);
    const processor = createCompileProcessor({ ...h.deps, freeBytes });
    await processor({ id: ID, data: GOOD });
    expect(freeBytes).not.toHaveBeenCalled();
  });

  it('pasa maxFileBytes a los argumentos de docker (--ulimit fsize)', async () => {
    const h = setup();
    await h.processor({ id: ID, data: GOOD });
    const args = (h.runContainer.mock.calls[0]?.[0] as RunContainerOptions).args;
    expect(args).toContain(`fsize=${h.deps.maxFileBytes}`);
  });
});
