// Processor sin Docker, Redis ni MinIO: workspace, storage y runContainer falsos.
import { compilationArtifactKey, compilationInputPrefix } from '@latexweb/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RunContainerOptions, RunContainerResult } from '../src/docker';
import { createCompileProcessor, InfrastructureError, InvalidJobError, type ProcessorDeps } from '../src/processor';
import type { Artifacts, Workspace } from '../src/workspace';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const GOOD = { compilationId: ID, engine: 'pdflatex', mainFile: 'main.tex' };
const INPUT = compilationInputPrefix(ID);
const LOG = './main.tex:3: Undefined control sequence.\nl.3 \\foo\n';

interface Setup {
  run?: Partial<RunContainerResult>;
  runRejects?: Error;
  artifacts?: Partial<Artifacts>;
  cleanupRejects?: Error;
  objects?: Record<string, string>;
}

function setup(s: Setup = {}) {
  const calls: string[] = [];
  const written = new Map<string, string>();
  const uploaded = new Map<string, Buffer>();
  const objects = s.objects ?? { [`${INPUT}main.tex`]: '\\documentclass{article}', [`${INPUT}fig/a.png`]: 'PNG' };
  const workspace: Workspace = {
    prepare: vi.fn(async (id: string) => {
      calls.push('prepare');
      return { inputDir: `/data/${id}/input`, outputDir: `/data/${id}/out` };
    }),
    writeInput: vi.fn(async (_id: string, path: string, data: Buffer) => {
      written.set(path, data.toString());
    }),
    collectArtifacts: vi.fn(async (): Promise<Artifacts> => {
      calls.push('collect');
      return { pdf: Buffer.from('%PDF'), pdfTooLarge: false, log: Buffer.from(LOG), synctex: Buffer.from('gz'), blg: null, ...s.artifacts };
    }),
    cleanup: vi.fn(async () => {
      calls.push('cleanup');
      if (s.cleanupRejects) throw s.cleanupRejects;
    }),
    sweepExpired: async () => ({ removed: [], failed: [] }),
  };
  const runContainer = vi.fn<(options: RunContainerOptions) => Promise<RunContainerResult>>(async () => {
    calls.push('run');
    if (s.runRejects) throw s.runRejects;
    return { exitCode: 0, killedByWorker: false, durationMs: 1234, stderrTail: '', ...s.run };
  });
  const logError = vi.fn();
  const deps: ProcessorDeps = {
    workspace,
    storage: {
      list: async (prefix) => Object.entries(objects).filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length })),
      getBuffer: async (key) => Buffer.from(objects[key] ?? ''),
      put: async (key, body) => {
        uploaded.set(key, body);
      },
    },
    containerUser: { uid: 1001, gid: 1002 },
    image: 'latexweb-texlive:test',
    timeoutSeconds: 42,
    cpus: 1,
    memory: '1g',
    pidsLimit: 128,
    tmpfsSize: '256m',
    maxFileBytes: 52428801,
    maxInputBytes: 1000,
    maxInputFiles: 10,
    runContainer,
    logError,
  };
  return { calls, written, uploaded, workspace, deps, runContainer, logError, processor: createCompileProcessor(deps) };
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
    expect(h.calls).toEqual([]);
  });

  it('baja la instantánea, compila, sube los artefactos y devuelve los diagnósticos', async () => {
    const h = setup({ run: { exitCode: 12, durationMs: 987 } });
    const result = await h.processor({ id: ID, data: { ...GOOD, engine: 'xelatex' } });
    expect(result).toEqual({
      outcome: 'error',
      exitCode: 12,
      durationMs: 987,
      hasPdf: true,
      hasLog: true,
      hasSynctex: true,
      pdfMissingReason: null,
      diagnostics: [{ file: 'main.tex', line: 3, level: 'error', message: 'Undefined control sequence.' }],
    });
    expect(h.calls).toEqual(['prepare', 'run', 'collect', 'cleanup']);
    expect([...h.written.keys()].sort()).toEqual(['fig/a.png', 'main.tex']);
    expect([...h.uploaded.keys()].sort()).toEqual(
      [compilationArtifactKey(ID, 'log'), compilationArtifactKey(ID, 'pdf'), compilationArtifactKey(ID, 'synctex')].sort(),
    );
    const options = h.runContainer.mock.calls[0]![0] as RunContainerOptions;
    expect(options.args.slice(-2)).toEqual(['-pdfxe', 'main.tex']);
  });

  it('una instantánea que supera los topes falla sin compilar', async () => {
    const h = setup({ objects: { [`${INPUT}main.tex`]: 'x'.repeat(1001) } });
    await expect(h.processor({ id: ID, data: GOOD })).rejects.toThrow(InvalidJobError);
    expect(h.runContainer).not.toHaveBeenCalled();
  });

  it.each<[string, Setup, Record<string, unknown>]>([
    ['PDF demasiado grande', { artifacts: { pdf: null, pdfTooLarge: true } }, { outcome: 'error', pdfMissingReason: 'too_large' }],
    ['error de LaTeX', { run: { exitCode: 12 }, artifacts: { pdf: null } }, { outcome: 'error', pdfMissingReason: 'not_produced' }],
    ['timeout interno', { run: { exitCode: 124 }, artifacts: { pdf: null } }, { outcome: 'timeout' }],
    ['matado por el worker', { run: { exitCode: null, killedByWorker: true }, artifacts: { pdf: null } }, { outcome: 'timeout' }],
  ])('%s es un resultado, no una excepción', async (_name, s, expected) => {
    expect(await setup(s).processor({ id: ID, data: GOOD })).toMatchObject(expected);
  });

  it('un fallo de docker lanza InfrastructureError, lo registra y no sube nada', async () => {
    const h = setup({ run: { exitCode: 125, stderrTail: 'Unable to find image' }, artifacts: { pdf: null } });
    await expect(h.processor({ id: ID, data: GOOD })).rejects.toThrow(InfrastructureError);
    expect(String(h.logError.mock.calls[0]![0])).toContain('Unable to find image');
    expect(h.uploaded.size).toBe(0);
  });

  it.each<[string, Setup]>([
    ['éxito', {}],
    ['infraestructura', { run: { exitCode: 125 }, artifacts: { pdf: null } }],
    ['runContainer que rechaza', { runRejects: new Error('boom') }],
  ])('siempre limpia el trabajo (%s)', async (_name, s) => {
    const h = setup(s);
    await h.processor({ id: ID, data: GOOD }).catch(() => undefined);
    expect(h.workspace.cleanup).toHaveBeenCalledExactlyOnceWith(ID);
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
    expect(h.calls).toEqual([]);
  });
});
