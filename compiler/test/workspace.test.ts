// Disco de trabajo de las compilaciones: preparar, publicar artefactos con topes, limpiar y barrer.
// Lo de seguridad: nunca publicar un symlink ni un directorio, y nunca borrar fuera de lo propio.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalWorkspace, prepareStorageRoot, WorkspaceError, type LocalWorkspaceOptions, type Workspace } from '../src/workspace';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const USER = { uid: 1001, gid: 1002 };
const MAX_PDF = 100;
const MAX_LOG = 50;
const NOTHING = { hasPdf: false, pdfTooLarge: false, hasLog: false, logTruncated: false };

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
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

/** Crea <root>/<id>/input y <root>/<id>/out. */
async function setupJob(id = ID) {
  const dir = path.join(root, id);
  await fs.mkdir(path.join(dir, 'input'), { recursive: true });
  await fs.mkdir(path.join(dir, 'out'));
  return { dir, input: path.join(dir, 'input'), out: path.join(dir, 'out') };
}

/** En Windows sin modo desarrollador no se pueden crear symlinks de archivo. */
const fileSymlinks = await (async () => {
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
})();

describe('prepareInputs', () => {
  it('deja out/ vacío (también en un reintento) y como root lo entrega al usuario del contenedor', async () => {
    const { dir, out } = await setupJob();
    await fs.writeFile(path.join(out, 'stale.aux'), 'old');
    await fs.writeFile(path.join(dir, 'output.pdf'), 'old');
    const chownDir = vi.fn(async () => {});

    const paths = await make({ getuid: () => 0, chownDir }).prepareInputs(ID);

    expect(paths).toEqual({ inputDir: path.join(root, ID, 'input'), outputDir: out });
    expect(await fs.readdir(out)).toEqual([]);
    expect(await exists(path.join(dir, 'output.pdf'))).toBe(false);
    expect(chownDir).toHaveBeenCalledWith(out, USER.uid, USER.gid);
  });

  it('rechaza un job sin input/ o con un id que no es uuid', async () => {
    await expect(make().prepareInputs(ID)).rejects.toThrow(WorkspaceError);
    await expect(make().prepareInputs('../x')).rejects.toThrow(WorkspaceError);
  });
});

describe('publishArtifacts', () => {
  it('publica un PDF y un log válidos', async () => {
    const { dir, out } = await setupJob();
    const pdf = Buffer.from('%PDF-1.5 contenido\x00\xff', 'latin1');
    await fs.writeFile(path.join(out, 'output.pdf'), pdf);
    await fs.writeFile(path.join(out, 'output.log'), 'log ok');

    expect(await make().publishArtifacts(ID)).toEqual({ hasPdf: true, pdfTooLarge: false, hasLog: true, logTruncated: false });
    expect(await fs.readFile(path.join(dir, 'output.pdf'))).toEqual(pdf);
    expect(await fs.readFile(path.join(dir, 'output.log'), 'utf8')).toBe('log ok');
  });

  it('no publica un PDF mayor que el tope y publica el final del log con un aviso', async () => {
    const { dir, out } = await setupJob();
    await fs.writeFile(path.join(out, 'output.pdf'), Buffer.alloc(MAX_PDF + 1, 1));
    const log = Buffer.from('0123456789'.repeat(100));
    await fs.writeFile(path.join(out, 'output.log'), log);

    expect(await make().publishArtifacts(ID)).toEqual({ hasPdf: false, pdfTooLarge: true, hasLog: true, logTruncated: true });
    expect(await exists(path.join(dir, 'output.pdf'))).toBe(false);
    const published = await fs.readFile(path.join(dir, 'output.log'));
    expect(published.toString('utf8')).toMatch(/^\[latexweb\] El log original tenía 1000 bytes/);
    expect(published.subarray(published.length - MAX_LOG)).toEqual(log.subarray(log.length - MAX_LOG));
  });

  it('no publica directorios', async () => {
    const { out } = await setupJob();
    await fs.mkdir(path.join(out, 'output.pdf'));
    await fs.mkdir(path.join(out, 'output.log'));
    expect(await make().publishArtifacts(ID)).toEqual(NOTHING);
  });

  it.skipIf(!fileSymlinks)('no publica symlinks a archivos de fuera', async () => {
    const { dir, out } = await setupJob();
    const secret = path.join(base, 'secret');
    await fs.writeFile(secret, 'SECRETO'.repeat(100));
    await fs.symlink(secret, path.join(out, 'output.pdf'), 'file');
    await fs.symlink(secret, path.join(out, 'output.log'), 'file');

    expect(await make().publishArtifacts(ID)).toEqual(NOTHING);
    expect(await exists(path.join(dir, 'output.log'))).toBe(false);
  });
});

describe('cleanupWork y sweepExpired', () => {
  it('cleanupWork borra input/ y out/, conserva los artefactos y es idempotente', async () => {
    const { dir, input, out } = await setupJob();
    await fs.writeFile(path.join(dir, 'output.pdf'), 'pdf');
    const ws = make();
    await ws.cleanupWork(ID);
    await ws.cleanupWork(ID);
    expect(await exists(input)).toBe(false);
    expect(await exists(out)).toBe(false);
    expect(await fs.readFile(path.join(dir, 'output.pdf'), 'utf8')).toBe('pdf');
  });

  it('el barrido borra solo directorios uuid vencidos', async () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const maxAge = 60_000;
    const dirAt = async (name: string, mtimeMs: number) => {
      const p = path.join(root, name);
      await fs.mkdir(p);
      await fs.utimes(p, mtimeMs / 1000, mtimeMs / 1000);
      return p;
    };
    const oldId = randomUUID();
    await dirAt(oldId, now - maxAge - 1000);
    const fresh = await dirAt(randomUUID(), now - 1000);
    const foreign = await dirAt('no-es-uuid', 0);

    expect(await make().sweepExpired(maxAge, now)).toEqual({ removed: [oldId], failed: [] });
    expect(await exists(fresh)).toBe(true);
    expect(await exists(foreign)).toBe(true);
  });
});

describe('prepareStorageRoot', () => {
  it('crea la raíz y rechaza un archivo o un enlace en su lugar', async () => {
    const created = path.join(base, 'a', 'raiz');
    await prepareStorageRoot(created);
    expect((await fs.lstat(created)).isDirectory()).toBe(true);

    const file = path.join(base, 'archivo');
    await fs.writeFile(file, 'x');
    await expect(prepareStorageRoot(file)).rejects.toThrow();

    const link = path.join(base, 'enlace');
    await fs.symlink(created, link, 'junction');
    await expect(prepareStorageRoot(link)).rejects.toBeInstanceOf(WorkspaceError);
  });
});
