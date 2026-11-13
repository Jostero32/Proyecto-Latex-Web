import { describe, expect, it } from 'vitest';
import type { CompileJobResult } from '@latexweb/shared';
import type { JobSnapshot } from './compilations.queue';
import { artifactAvailability, buildStatusResponse } from './compilations.status';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const TTL = 3600;
const CREATED = Date.parse('2026-01-01T10:00:00.000Z');
const FINISHED = Date.parse('2026-01-01T10:00:05.500Z');

const result = (over: Partial<CompileJobResult> = {}): CompileJobResult => ({
  outcome: 'success',
  exitCode: 0,
  durationMs: 5000,
  hasPdf: true,
  hasLog: true,
  pdfMissingReason: null,
  ...over,
});

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  state: 'completed',
  data: { compilationId: ID, mainFile: 'tesis/main.tex', engine: 'xelatex' },
  createdAt: CREATED,
  finishedAt: FINISHED,
  result: result(),
  ...over,
});

const base = (state: JobSnapshot['state']): JobSnapshot => ({
  state,
  data: { compilationId: ID, mainFile: 'tesis/main.tex', engine: 'xelatex' },
  createdAt: CREATED,
});

const pending = (state: 'queued' | 'running'): JobSnapshot => base(state);

/** failed o completed sin result: tiene finishedAt pero ningún resultado. */
const noResult = (state: 'failed' | 'completed'): JobSnapshot => ({ ...base(state), finishedAt: FINISHED });

describe('buildStatusResponse', () => {
  it.each(['queued', 'running'] as const)('%s pasa tal cual y no trae campos de resultado', (state) => {
    const res = buildStatusResponse(ID, pending(state), TTL);
    expect(res).toEqual({
      id: ID,
      status: state,
      engine: 'xelatex',
      mainFile: 'tesis/main.tex',
      createdAt: '2026-01-01T10:00:00.000Z',
    });
    for (const key of ['finishedAt', 'expiresAt', 'pdfUrl', 'logUrl']) expect(res).not.toHaveProperty(key);
  });

  it.each(['success', 'error', 'timeout'] as const)('completed con outcome %s', (outcome) => {
    const res = buildStatusResponse(ID, job({ result: result({ outcome, exitCode: outcome === 'timeout' ? null : 1 }) }), TTL);
    expect(res.status).toBe(outcome);
    expect(res.exitCode).toBe(outcome === 'timeout' ? null : 1);
    expect(res.durationMs).toBe(5000);
    expect(res.pdfMissingReason).toBeNull();
  });

  it('completed: finishedAt y expiresAt (= finishedAt + TTL) son ISO', () => {
    const res = buildStatusResponse(ID, job(), TTL);
    expect(res.createdAt).toBe('2026-01-01T10:00:00.000Z');
    expect(res.finishedAt).toBe('2026-01-01T10:00:05.500Z');
    expect(res.expiresAt).toBe(new Date(FINISHED + TTL * 1000).toISOString());
    expect(res.expiresAt).toBe('2026-01-01T11:00:05.500Z');
  });

  it('pdfUrl y logUrl según hasPdf y hasLog', () => {
    const both = buildStatusResponse(ID, job(), TTL);
    expect(both.pdfUrl).toBe(`/compilations/${ID}/pdf`);
    expect(both.logUrl).toBe(`/compilations/${ID}/log`);

    const none = buildStatusResponse(
      ID,
      job({ result: result({ outcome: 'error', hasPdf: false, hasLog: false, pdfMissingReason: 'not_produced' }) }),
      TTL,
    );
    expect(none).not.toHaveProperty('pdfUrl');
    expect(none).not.toHaveProperty('logUrl');
    expect(none.pdfMissingReason).toBe('not_produced');

    const onlyLog = buildStatusResponse(
      ID,
      job({ result: result({ hasPdf: false, pdfMissingReason: 'too_large' }) }),
      TTL,
    );
    expect(onlyLog).not.toHaveProperty('pdfUrl');
    expect(onlyLog.logUrl).toBe(`/compilations/${ID}/log`);
    expect(onlyLog.pdfMissingReason).toBe('too_large');
  });

  it('failed: status failed, con finishedAt y sin urls', () => {
    const res = buildStatusResponse(ID, noResult('failed'), TTL);
    expect(res.status).toBe('failed');
    expect(res.finishedAt).toBe('2026-01-01T10:00:05.500Z');
    expect(res).not.toHaveProperty('pdfUrl');
    expect(res).not.toHaveProperty('logUrl');
  });

  it('completed sin result se trata como failed', () => {
    const res = buildStatusResponse(ID, noResult('completed'), TTL);
    expect(res.status).toBe('failed');
    expect(res).not.toHaveProperty('pdfUrl');
    expect(res).not.toHaveProperty('logUrl');
  });

  it('engine y mainFile salen de data', () => {
    const res = buildStatusResponse(ID, job({ data: { compilationId: ID, mainFile: 'a/b.tex', engine: 'lualatex' } }), TTL);
    expect(res.engine).toBe('lualatex');
    expect(res.mainFile).toBe('a/b.tex');
    expect(res.id).toBe(ID);
  });
});

describe('artifactAvailability', () => {
  const NOW = FINISHED + 1000;
  const noPdf = (reason: 'too_large' | 'not_produced') =>
    job({ result: result({ outcome: 'error', hasPdf: false, pdfMissingReason: reason }) });

  type Row = [string, JobSnapshot, 'pdf' | 'log', number, string | null];
  const rows: Row[] = [
    ['queued pdf', pending('queued'), 'pdf', 409, 'not_ready'],
    ['queued log', pending('queued'), 'log', 409, 'not_ready'],
    ['running pdf', pending('running'), 'pdf', 409, 'not_ready'],
    ['running log', pending('running'), 'log', 409, 'not_ready'],
    ['failed pdf', noResult('failed'), 'pdf', 404, 'artifact_not_available'],
    ['failed log', noResult('failed'), 'log', 404, 'artifact_not_available'],
    ['completed sin result', noResult('completed'), 'pdf', 404, 'artifact_not_available'],
    ['pdf too_large', noPdf('too_large'), 'pdf', 404, 'pdf_too_large'],
    ['pdf not_produced', noPdf('not_produced'), 'pdf', 404, 'artifact_not_available'],
    ['log ausente', job({ result: result({ hasLog: false }) }), 'log', 404, 'artifact_not_available'],
    ['pdf disponible', job(), 'pdf', 200, null],
    ['log disponible', job(), 'log', 200, null],
    ['log disponible sin pdf', noPdf('too_large'), 'log', 200, null],
  ];

  it.each(rows)('%s', (_label, snapshot, kind, status, code) => {
    const res = artifactAvailability(snapshot, kind, TTL, NOW);
    if (code === null) expect(res).toEqual({ available: true });
    else expect(res).toEqual({ available: false, statusCode: status, code });
  });

  it('vencido: 410 expired, también si el artefacto existiría', () => {
    const now = FINISHED + TTL * 1000 + 1;
    expect(artifactAvailability(job(), 'pdf', TTL, now)).toEqual({ available: false, statusCode: 410, code: 'expired' });
    expect(artifactAvailability(job(), 'log', TTL, now)).toEqual({ available: false, statusCode: 410, code: 'expired' });
  });

  it('en el borde exacto (now === finishedAt + TTL) sigue disponible', () => {
    expect(artifactAvailability(job(), 'pdf', TTL, FINISHED + TTL * 1000)).toEqual({ available: true });
  });
});
