// Processor sin Docker ni Redis: Workspace y runContainer falsos. Ver docs/specs/compilacion.md,
// "Estados y resultado".
import { describe, expect, it, vi } from 'vitest';
import type { RunContainerOptions, RunContainerResult } from '../src/docker';
import { createCompileProcessor, InfrastructureError, InvalidJobError, type ProcessorDeps } from '../src/processor';
import type { PublishResult, Workspace } from '../src/workspace';

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

describe('processor', () => {
  it.each<[string, unknown]>([
    ['null', null],
    ['compilationId no uuid', { ...GOOD, compilationId: 'no-es-uuid' }],
    ['motor inválido', { ...GOOD, engine: 'latex' }],
    ['mainFile -e.tex', { ...GOOD, mainFile: '-e.tex' }],
    ['mainFile ../x.tex', { ...GOOD, mainFile: '../x.tex' }],
  ])('rechaza el payload %s sin preparar ni ejecutar', async (_name, data) => {
    const h = setup();
    await expect(h.processor({ id: ID, data })).rejects.toThrow(InvalidJobError);
    expect(h.prepareInputs).not.toHaveBeenCalled();
    expect(h.runContainer).not.toHaveBeenCalled();
  });

  it('rechaza un job cuyo id no coincide con compilationId', async () => {
    const h = setup();
    await expect(h.processor({ id: '223e4567-e89b-42d3-a456-426614174000', data: GOOD })).rejects.toThrow(InvalidJobError);
    expect(h.runContainer).not.toHaveBeenCalled();
  });

  it('éxito: prepara, compila con los argumentos del motor, publica y limpia, en ese orden', async () => {
    const h = setup({ run: { exitCode: 0, durationMs: 987 }, publish: { hasLog: false } });
    const result = await h.processor({ id: ID, data: { ...GOOD, engine: 'xelatex', mainFile: 'tesis.tex' } });
    expect(result).toEqual({ outcome: 'success', exitCode: 0, durationMs: 987, hasPdf: true, hasLog: false, pdfMissingReason: null });
    expect(h.calls).toEqual([`prepareInputs:${ID}`, 'runContainer', `publishArtifacts:${ID}`, `cleanupWork:${ID}`]);
    const options = h.runContainer.mock.calls[0]![0] as RunContainerOptions;
    expect(options.containerName).toBe(`latexweb-compile-${ID}`);
    expect(options.args.slice(-2)).toEqual(['-pdfxe', 'tesis.tex']);
    expect(options.args).toContain(`fsize=${h.deps.maxFileBytes}`);
  });

  it.each<[string, Setup, Record<string, unknown>]>([
    ['PDF demasiado grande', { publish: { hasPdf: false, pdfTooLarge: true } }, { outcome: 'error', pdfMissingReason: 'too_large' }],
    ['error de LaTeX', { run: { exitCode: 12 }, publish: { hasPdf: false } }, { outcome: 'error', pdfMissingReason: 'not_produced' }],
    ['timeout interno', { run: { exitCode: 124 }, publish: { hasPdf: false } }, { outcome: 'timeout' }],
    ['matado por el worker', { run: { exitCode: null, killedByWorker: true }, publish: { hasPdf: false } }, { outcome: 'timeout' }],
  ])('%s es un resultado, no una excepción', async (_name, s, expected) => {
    const h = setup(s);
    expect(await h.processor({ id: ID, data: GOOD })).toMatchObject(expected);
  });

  it('un fallo de docker lanza InfrastructureError y lo registra con el id y stderr', async () => {
    const h = setup({ run: { exitCode: 125, stderrTail: 'Unable to find image' }, publish: { hasPdf: false } });
    await expect(h.processor({ id: ID, data: GOOD })).rejects.toThrow(InfrastructureError);
    const message = String(h.logError.mock.calls[0]![0]);
    expect(message).toContain(ID);
    expect(message).toContain('Unable to find image');
  });

  it.each<[string, Setup]>([
    ['éxito', {}],
    ['infraestructura', { run: { exitCode: 125 }, publish: { hasPdf: false } }],
    ['runContainer que rechaza', { runRejects: new Error('boom') }],
  ])('siempre limpia el trabajo (%s)', async (_name, s) => {
    const h = setup(s);
    await h.processor({ id: ID, data: GOOD }).catch(() => undefined);
    expect(h.cleanupWork).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it('si la limpieza falla, no tapa el resultado', async () => {
    const h = setup({ cleanupRejects: new Error('EBUSY') });
    expect((await h.processor({ id: ID, data: GOOD })).outcome).toBe('success');
    expect(String(h.logError.mock.calls[0]![0])).toContain('EBUSY');
  });

  it('con poco espacio libre falla sin preparar ni compilar', async () => {
    const h = setup();
    const processor = createCompileProcessor({ ...h.deps, minFreeBytes: 1000, freeBytes: async () => 999 });
    await expect(processor({ id: ID, data: GOOD })).rejects.toBeInstanceOf(InfrastructureError);
    expect(h.prepareInputs).not.toHaveBeenCalled();
  });
});
