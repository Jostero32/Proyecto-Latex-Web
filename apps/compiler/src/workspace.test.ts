import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalWorkspace, WorkspaceError, type LocalWorkspaceOptions, type Workspace } from './workspace';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const USER = { uid: 1001, gid: 1002 };
const MAX_PDF = 100;
const MAX_LOG = 50;

let base: string;
let root: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'latexweb-ws-test-'));
  root = path.join(base, 'root');
  await fs.mkdir(root);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function make(overrides: Partial<LocalWorkspaceOptions> = {}): Workspace {
  return createLocalWorkspace({
    root,
    maxPdfBytes: MAX_PDF,
    maxLogBytes: MAX_LOG,
    containerUser: USER,
    getuid: () => 1000,
    chownDir: async () => {},
    ...overrides,
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Crea <root>/<id>/input y devuelve las rutas. */
async function setupJob(id = ID) {
  const dir = path.join(root, id);
  await fs.mkdir(path.join(dir, 'input'), { recursive: true });
  return { dir, input: path.join(dir, 'input'), out: path.join(dir, 'out') };
}

// Detecta una vez si se pueden crear symlinks de archivo (en Windows sin modo desarrollador da EPERM).
async function canCreateFileSymlinks(): Promise<boolean> {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'latexweb-ws-test-'));
  try {
    await fs.writeFile(path.join(probe, 'a'), 'x');
    await fs.symlink(path.join(probe, 'a'), path.join(probe, 'b'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}
const fileSymlinks = await canCreateFileSymlinks();

async function canCreateJunctions(): Promise<boolean> {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'latexweb-ws-test-'));
  try {
    await fs.mkdir(path.join(probe, 'a'));
    await fs.symlink(path.join(probe, 'a'), path.join(probe, 'b'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}
const junctions = await canCreateJunctions();

describe('construcción', () => {
  it.each([
    ['relativa', 'relative/dir'],
    ['con coma', path.join(os.tmpdir(), 'a,b')],
    ['con comillas', path.join(os.tmpdir(), 'a"b')],
    ['con salto de línea', path.join(os.tmpdir(), 'a\nb')],
  ])('rechaza una raíz %s', (_name, bad) => {
    expect(() => make({ root: bad })).toThrow(WorkspaceError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rechaza maxPdfBytes = %s', (value) => {
    expect(() => make({ maxPdfBytes: value })).toThrow(WorkspaceError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rechaza maxLogBytes = %s', (value) => {
    expect(() => make({ maxLogBytes: value })).toThrow(WorkspaceError);
  });

  it('acepta valores válidos', () => {
    expect(() => make()).not.toThrow();
  });
});

describe('ids', () => {
  const badIds = ['../x', '..', ID.toUpperCase(), ''];

  it.each(badIds)('los cuatro métodos con id %j lanzan WorkspaceError', async (bad) => {
    // Un directorio hermano de la raíz con la forma que tendría un job.
    const outside = path.join(base, 'x');
    await fs.mkdir(path.join(outside, 'input'), { recursive: true });
    await fs.writeFile(path.join(outside, 'input', 'keep.txt'), 'keep');
    const ws = make();

    await expect(ws.prepareInputs(bad)).rejects.toThrow(WorkspaceError);
    await expect(ws.publishArtifacts(bad)).rejects.toThrow(WorkspaceError);
    await expect(ws.cleanupWork(bad)).rejects.toThrow(WorkspaceError);

    expect(await fs.readFile(path.join(outside, 'input', 'keep.txt'), 'utf8')).toBe('keep');
    expect(await exists(path.join(outside, 'out'))).toBe(false);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('sweepExpired no recibe ids (solo valida maxAgeMs)', async () => {
    await expect(make().sweepExpired(-1)).rejects.toThrow(WorkspaceError);
  });
});

describe('prepareInputs', () => {
  it('devuelve rutas absolutas con out/ vacío', async () => {
    const { dir } = await setupJob();
    const paths = await make().prepareInputs(ID);

    expect(paths.inputDir).toBe(path.join(root, ID, 'input'));
    expect(paths.outputDir).toBe(path.join(root, ID, 'out'));
    expect(path.isAbsolute(paths.inputDir)).toBe(true);
    expect(path.isAbsolute(paths.outputDir)).toBe(true);
    expect((await fs.lstat(paths.outputDir)).isDirectory()).toBe(true);
    expect(await fs.readdir(paths.outputDir)).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });

  it('lanza si input/ no existe', async () => {
    await fs.mkdir(path.join(root, ID));
    await expect(make().prepareInputs(ID)).rejects.toThrow(WorkspaceError);
  });

  it('lanza si el directorio del job no existe', async () => {
    await expect(make().prepareInputs(ID)).rejects.toThrow(WorkspaceError);
  });

  it('lanza si input es un archivo', async () => {
    await fs.mkdir(path.join(root, ID));
    await fs.writeFile(path.join(root, ID, 'input'), 'x');
    await expect(make().prepareInputs(ID)).rejects.toThrow(WorkspaceError);
  });

  it.skipIf(!junctions)('lanza si input es un symlink a un directorio', async () => {
    const target = path.join(base, 'target');
    await fs.mkdir(target);
    await fs.mkdir(path.join(root, ID));
    await fs.symlink(target, path.join(root, ID, 'input'), 'junction');
    await expect(make().prepareInputs(ID)).rejects.toThrow(WorkspaceError);
    expect(await exists(path.join(target, 'out'))).toBe(false);
  });

  it('en un reintento borra out/ previo y artefactos ya publicados', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(path.join(out, 'sub'), { recursive: true });
    await fs.writeFile(path.join(out, 'sub', 'stale.aux'), 'old');
    await fs.writeFile(path.join(out, 'main.pdf'), 'old');
    await fs.writeFile(path.join(dir, 'output.pdf'), 'old');
    await fs.writeFile(path.join(dir, 'output.log'), 'old');

    const { outputDir } = await make().prepareInputs(ID);

    expect(await fs.readdir(outputDir)).toEqual([]);
    expect(await exists(path.join(dir, 'output.pdf'))).toBe(false);
    expect(await exists(path.join(dir, 'output.log'))).toBe(false);
    expect(await exists(path.join(dir, 'input'))).toBe(true);
  });

  it('con getuid 0 hace chown de out/ al usuario del contenedor', async () => {
    await setupJob();
    const chownDir = vi.fn(async () => {});
    const { outputDir } = await make({ getuid: () => 0, chownDir }).prepareInputs(ID);
    expect(chownDir).toHaveBeenCalledTimes(1);
    expect(chownDir).toHaveBeenCalledWith(outputDir, USER.uid, USER.gid);
  });

  it('con getuid 1000 no hace chown', async () => {
    await setupJob();
    const chownDir = vi.fn(async () => {});
    await make({ getuid: () => 1000, chownDir }).prepareInputs(ID);
    expect(chownDir).not.toHaveBeenCalled();
  });

  it('con getuid undefined no hace chown', async () => {
    await setupJob();
    const chownDir = vi.fn(async () => {});
    await make({ getuid: undefined, chownDir }).prepareInputs(ID);
    expect(chownDir).not.toHaveBeenCalled();
  });
});

describe('publishArtifacts', () => {
  it('publica un PDF y un log válidos', async () => {
    const { dir, out } = await setupJob();
    const pdf = Buffer.from('%PDF-1.5 contenido\x00\xff', 'latin1');
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, 'output.pdf'), pdf);
    await fs.writeFile(path.join(out, 'output.log'), 'log ok');

    const result = await make().publishArtifacts(ID);

    expect(result).toEqual({ hasPdf: true, hasLog: true, logTruncated: false });
    expect(await fs.readFile(path.join(dir, 'output.pdf'))).toEqual(pdf);
    expect(await fs.readFile(path.join(dir, 'output.log'), 'utf8')).toBe('log ok');
    expect(await exists(path.join(out, 'output.pdf'))).toBe(false);
    expect(await exists(path.join(out, 'output.log'))).toBe(false);
  });

  it('sin archivos devuelve todo en false', async () => {
    const { out } = await setupJob();
    await fs.mkdir(out);
    expect(await make().publishArtifacts(ID)).toEqual({ hasPdf: false, hasLog: false, logTruncated: false });
  });

  it('sin out/ tampoco falla', async () => {
    await setupJob();
    expect(await make().publishArtifacts(ID)).toEqual({ hasPdf: false, hasLog: false, logTruncated: false });
  });

  it('solo log: hasPdf false y hasLog true', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, 'output.log'), '! Undefined control sequence.');

    expect(await make().publishArtifacts(ID)).toEqual({ hasPdf: false, hasLog: true, logTruncated: false });
    expect(await exists(path.join(dir, 'output.pdf'))).toBe(false);
    expect(await fs.readFile(path.join(dir, 'output.log'), 'utf8')).toBe('! Undefined control sequence.');
  });

  it('un PDF de maxPdfBytes + 1 no se publica', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, 'output.pdf'), Buffer.alloc(MAX_PDF + 1, 1));

    const result = await make().publishArtifacts(ID);
    expect(result.hasPdf).toBe(false);
    expect(await exists(path.join(dir, 'output.pdf'))).toBe(false);
  });

  it('un PDF de exactamente maxPdfBytes sí se publica', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, 'output.pdf'), Buffer.alloc(MAX_PDF, 1));

    const result = await make().publishArtifacts(ID);
    expect(result.hasPdf).toBe(true);
    expect((await fs.stat(path.join(dir, 'output.pdf'))).size).toBe(MAX_PDF);
  });

  it('un log de exactamente maxLogBytes se publica íntegro', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(out);
    const log = 'a'.repeat(MAX_LOG);
    await fs.writeFile(path.join(out, 'output.log'), log);

    expect(await make().publishArtifacts(ID)).toEqual({ hasPdf: false, hasLog: true, logTruncated: false });
    expect(await fs.readFile(path.join(dir, 'output.log'), 'utf8')).toBe(log);
  });

  it('un log de maxLogBytes + 1 se publica truncado con aviso', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(out);
    const original = Buffer.from(Array.from({ length: MAX_LOG + 1 }, (_, i) => 65 + (i % 26)));
    await fs.writeFile(path.join(out, 'output.log'), original);

    const result = await make().publishArtifacts(ID);
    expect(result).toEqual({ hasPdf: false, hasLog: true, logTruncated: true });

    const published = await fs.readFile(path.join(dir, 'output.log'));
    const notice = `[latexweb] El log original tenía ${MAX_LOG + 1} bytes; se muestran los últimos ${MAX_LOG}.`;
    expect(published.subarray(0, Buffer.byteLength(notice)).toString('utf8')).toBe(notice);
    expect(published.subarray(published.length - MAX_LOG)).toEqual(original.subarray(original.length - MAX_LOG));
    expect(published.length).toBeGreaterThan(MAX_LOG);
    // No queda el temporal .tmp (el original sigue en out/ hasta cleanupWork).
    expect((await fs.readdir(dir)).sort()).toEqual(['input', 'out', 'output.log']);
  });

  it('un log mucho más grande reporta los números correctos', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(out);
    const original = Buffer.from('0123456789'.repeat(100));
    await fs.writeFile(path.join(out, 'output.log'), original);

    await make().publishArtifacts(ID);
    const published = await fs.readFile(path.join(dir, 'output.log'));
    expect(published.toString('utf8').startsWith(`[latexweb] El log original tenía 1000 bytes; se muestran los últimos ${MAX_LOG}.`)).toBe(true);
    expect(published.subarray(published.length - MAX_LOG)).toEqual(original.subarray(1000 - MAX_LOG));
  });

  it('output.pdf como directorio no se publica', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(path.join(out, 'output.pdf'), { recursive: true });
    await fs.mkdir(path.join(out, 'output.log'), { recursive: true });

    expect(await make().publishArtifacts(ID)).toEqual({ hasPdf: false, hasLog: false, logTruncated: false });
    expect(await exists(path.join(dir, 'output.pdf'))).toBe(false);
    expect(await exists(path.join(dir, 'output.log'))).toBe(false);
  });

  it.skipIf(!fileSymlinks)('output.pdf y output.log como symlink fuera de la raíz no se publican', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(out);
    const secretPdf = path.join(base, 'secret.pdf');
    const secretLog = path.join(base, 'secret.log');
    await fs.writeFile(secretPdf, 'SECRET-PDF');
    await fs.writeFile(secretLog, 'SECRET-LOG');
    await fs.symlink(secretPdf, path.join(out, 'output.pdf'), 'file');
    await fs.symlink(secretLog, path.join(out, 'output.log'), 'file');

    expect(await make().publishArtifacts(ID)).toEqual({ hasPdf: false, hasLog: false, logTruncated: false });
    expect(await exists(path.join(dir, 'output.pdf'))).toBe(false);
    expect(await exists(path.join(dir, 'output.log'))).toBe(false);
    expect(await fs.readFile(secretPdf, 'utf8')).toBe('SECRET-PDF');
    expect(await fs.readFile(secretLog, 'utf8')).toBe('SECRET-LOG');
  });

  it.skipIf(!fileSymlinks)('un symlink a un log enorme tampoco se publica truncado', async () => {
    const { dir, out } = await setupJob();
    await fs.mkdir(out);
    const secretLog = path.join(base, 'secret.log');
    await fs.writeFile(secretLog, 'S'.repeat(MAX_LOG * 4));
    await fs.symlink(secretLog, path.join(out, 'output.log'), 'file');

    expect(await make().publishArtifacts(ID)).toEqual({ hasPdf: false, hasLog: false, logTruncated: false });
    expect(await exists(path.join(dir, 'output.log'))).toBe(false);
  });
});

describe('cleanupWork', () => {
  it('borra input/ y out/ y conserva los artefactos', async () => {
    const { dir, input, out } = await setupJob();
    await fs.writeFile(path.join(input, 'main.tex'), 'x');
    await fs.mkdir(path.join(out, 'sub'), { recursive: true });
    await fs.writeFile(path.join(out, 'sub', 'f'), 'x');
    await fs.writeFile(path.join(dir, 'output.pdf'), 'pdf');
    await fs.writeFile(path.join(dir, 'output.log'), 'log');

    await make().cleanupWork(ID);

    expect(await exists(input)).toBe(false);
    expect(await exists(out)).toBe(false);
    expect(await fs.readFile(path.join(dir, 'output.pdf'), 'utf8')).toBe('pdf');
    expect(await fs.readFile(path.join(dir, 'output.log'), 'utf8')).toBe('log');
  });

  it('es idempotente', async () => {
    await setupJob();
    const ws = make();
    await ws.cleanupWork(ID);
    await expect(ws.cleanupWork(ID)).resolves.toBeUndefined();
  });

  it('no falla si el job nunca existió', async () => {
    await expect(make().cleanupWork(ID)).resolves.toBeUndefined();
  });
});

describe('sweepExpired', () => {
  const MAX_AGE = 60_000;
  const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

  async function makeDir(name: string, mtimeMs: number): Promise<string> {
    const p = path.join(root, name);
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(path.join(p, 'output.pdf'), 'x');
    await fs.utimes(p, mtimeMs / 1000, mtimeMs / 1000);
    return p;
  }

  it('borra los directorios uuid viejos y conserva los recientes', async () => {
    const oldId = randomUUID();
    const freshId = randomUUID();
    const oldDir = await makeDir(oldId, NOW - MAX_AGE - 1000);
    const freshDir = await makeDir(freshId, NOW - 1000);

    const result = await make().sweepExpired(MAX_AGE, NOW);

    expect(result).toEqual({ removed: [oldId], failed: [] });
    expect(await exists(oldDir)).toBe(false);
    expect(await exists(freshDir)).toBe(true);
  });

  it('nunca toca nombres que no son uuid, aunque sean viejos', async () => {
    const veryOld = NOW - 365 * 24 * 3600 * 1000;
    const noUuid = await makeDir('no-uuid', veryOld);
    const hidden = await makeDir('.hidden', veryOld);
    const upper = await makeDir(randomUUID().toUpperCase(), veryOld);
    const looseFile = path.join(root, randomUUID());
    await fs.writeFile(looseFile, 'x');
    await fs.utimes(looseFile, veryOld / 1000, veryOld / 1000);

    const result = await make().sweepExpired(MAX_AGE, NOW);

    expect(result).toEqual({ removed: [], failed: [] });
    expect(await exists(noUuid)).toBe(true);
    expect(await exists(hidden)).toBe(true);
    expect(await exists(upper)).toBe(true);
    expect((await fs.lstat(looseFile)).isFile()).toBe(true);
  });

  it.skipIf(!junctions)('no sigue un symlink con nombre uuid ni toca su destino', async () => {
    const target = path.join(base, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep'), 'keep');
    await fs.utimes(target, 0, 0);
    await fs.symlink(target, path.join(root, randomUUID()), 'junction');

    const result = await make().sweepExpired(MAX_AGE, NOW);

    expect(result.failed).toEqual([]);
    expect(await fs.readFile(path.join(target, 'keep'), 'utf8')).toBe('keep');
  });

  it('con la raíz inexistente devuelve listas vacías', async () => {
    const ws = make({ root: path.join(base, 'no-existe') });
    expect(await ws.sweepExpired(MAX_AGE, NOW)).toEqual({ removed: [], failed: [] });
  });

  it.each([-1, Number.NaN])('lanza con maxAgeMs = %s', async (value) => {
    await expect(make().sweepExpired(value, NOW)).rejects.toThrow(WorkspaceError);
  });

  it('con mtime exactamente igual a now - maxAgeMs no se borra', async () => {
    const id = randomUUID();
    const dir = await makeDir(id, NOW - MAX_AGE);
    // Se usa el mtime real del disco para evitar diferencias de precisión.
    const mtime = (await fs.stat(dir)).mtimeMs;

    const result = await make().sweepExpired(MAX_AGE, mtime + MAX_AGE);
    expect(result.removed).toEqual([]);
    expect(await exists(dir)).toBe(true);

    const later = await make().sweepExpired(MAX_AGE, mtime + MAX_AGE + 1);
    expect(later.removed).toEqual([id]);
    expect(await exists(dir)).toBe(false);
  });
});
