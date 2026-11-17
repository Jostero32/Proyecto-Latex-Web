// Tests unitarios de runner.ts sin Docker: node (process.execPath) hace de docker falso.
// Ver docs/specs/compilacion.md, "Ejecución en Docker" y "Estados y resultado".
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { classifyRun, runContainer, runDocker } from './runner';

describe('classifyRun', () => {
  const outcome = (o: string) => ({ kind: 'outcome', outcome: o });

  const cases: Array<[string, number | null, boolean, boolean, unknown]> = [
    ['killedByWorker con código 0', 0, true, true, outcome('timeout')],
    ['killedByWorker con código null', null, true, false, outcome('timeout')],
    ['killedByWorker con código 137', 137, true, false, outcome('timeout')],
    ['124 (timeout interno)', 124, false, false, outcome('timeout')],
    ['0 con PDF', 0, false, true, outcome('success')],
    ['0 sin PDF', 0, false, false, outcome('error')],
    ['12 con PDF', 12, false, true, outcome('error')],
    ['12 sin PDF', 12, false, false, outcome('error')],
    ['137 (SIGKILL/memoria)', 137, false, false, outcome('error')],
    ['1', 1, false, false, outcome('error')],
    ['11', 11, false, false, outcome('error')],
  ];

  it.each(cases)('%s', (_name, exitCode, killedByWorker, hasPdf, expected) => {
    expect(classifyRun({ exitCode, killedByWorker }, hasPdf)).toEqual(expected);
  });

  it.each([2, 125, 126, 127])('código %i es infraestructura y el reason lo menciona', (code) => {
    const result = classifyRun({ exitCode: code, killedByWorker: false }, false);
    expect(result.kind).toBe('infrastructure');
    if (result.kind === 'infrastructure') expect(result.reason).toContain(String(code));
  });

  it('infraestructura aunque haya PDF', () => {
    expect(classifyRun({ exitCode: 125, killedByWorker: false }, true).kind).toBe('infrastructure');
  });

  it('null sin killedByWorker es infraestructura', () => {
    expect(classifyRun({ exitCode: null, killedByWorker: false }, false).kind).toBe('infrastructure');
  });
});

describe('runContainer (docker falso = node)', () => {
  const base = { dockerBin: process.execPath, timeoutSeconds: 30 };

  it('devuelve el código de salida', async () => {
    const run = await runContainer({ ...base, containerName: 'fake-exit', args: ['-e', 'process.exit(12)'] });
    expect(run.exitCode).toBe(12);
    expect(run.killedByWorker).toBe(false);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.durationMs).toBeLessThan(10_000);
  }, 20_000);

  it('conserva solo el final de stderr (máx. 8 KB)', async () => {
    const run = await runContainer({
      ...base,
      containerName: 'fake-stderr',
      args: ['-e', 'process.stderr.write("x".repeat(20000)); process.stderr.write("FIN")'],
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderrTail.endsWith('FIN')).toBe(true);
    expect(Buffer.byteLength(run.stderrTail)).toBeLessThanOrEqual(8 * 1024);
    expect(run.stderrTail.length).toBeGreaterThan(1000);
  }, 20_000);

  it('mata el contenedor si excede timeout + margen', async () => {
    const run = await runContainer({
      ...base,
      timeoutSeconds: 0,
      killGraceMs: 300,
      containerName: 'fake-kill',
      args: ['-e', 'setTimeout(() => {}, 60000)'],
    });
    expect(run.killedByWorker).toBe(true);
    expect(run.durationMs).toBeLessThan(10_000);
    expect(classifyRun(run, false)).toEqual({ kind: 'outcome', outcome: 'timeout' });
  }, 20_000);

  it('rechaza si docker no existe (ENOENT) sin quedar colgada', async () => {
    await expect(
      runContainer({
        ...base,
        dockerBin: join(tmpdir(), 'no-existe-docker-xyz'),
        containerName: 'fake-enoent',
        args: ['run'],
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);
});

describe('runDocker (subcomandos auxiliares)', () => {
  it('no se queda colgado si el comando no termina: lo mata al vencer el timeout', async () => {
    const started = Date.now();
    await runDocker(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 300);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('con un ejecutable inexistente resuelve sin lanzar', async () => {
    await expect(runDocker(join(tmpdir(), 'no-existe-docker-bin'), ['rm', '-f', 'x'])).resolves.toBeUndefined();
  });
});
