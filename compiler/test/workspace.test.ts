// Disco de trabajo de las compilaciones: preparar, escribir la entrada, recoger artefactos con topes,
// limpiar y barrer. Lo de seguridad: rutas de entrada validadas, nunca leer un symlink ni un
// directorio como artefacto, y nunca borrar fuera de lo propio.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalWorkspace, prepareWorkRoot, WorkspaceError, type LocalWorkspaceOptions, type Workspace } from '../src/workspace';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const USER = { uid: 1001, gid: 1002 };
const MAX_PDF = 100;
const MAX_LOG = 50;
const NOTHING = { pdf: null, pdfTooLarge: false, log: null, synctex: null, blg: null };

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

describe('prepare y writeInput', () => {
  it('deja input/ y out/ vacíos (también en un reintento) y como root entrega out/ al usuario del contenedor', async () => {
    const chownDir = vi.fn(async () => {});
    const ws = make({ getuid: () => 0, chownDir });
    await ws.prepare(ID);
    await ws.writeInput(ID, 'viejo.tex', Buffer.from('x'));
    const paths = await ws.prepare(ID);

    expect(paths).toEqual({ inputDir: path.join(root, ID, 'input'), outputDir: path.join(root, ID, 'out') });
    expect(await fs.readdir(paths.inputDir)).toEqual([]);
    expect(await fs.readdir(paths.outputDir)).toEqual([]);
    expect(chownDir).toHaveBeenCalledWith(paths.outputDir, USER.uid, USER.gid);
  });

  it('escribe rutas con carpetas, ignora latexmkrc y ocultos, y rechaza rutas que salen de input/', async () => {
    const ws = make();
    const { inputDir } = await ws.prepare(ID);
    await ws.writeInput(ID, 'figuras/a.png', Buffer.from('PNG'));
    await ws.writeInput(ID, 'latexmkrc', Buffer.from('system("x")'));
    await ws.writeInput(ID, '.oculto', Buffer.from('x'));
    expect(await fs.readFile(path.join(inputDir, 'figuras', 'a.png'), 'utf8')).toBe('PNG');
    expect(await fs.readdir(inputDir)).toEqual(['figuras']);

    for (const bad of ['../fuera.tex', '/etc/passwd', 'a/../../b', 'C:/x']) {
      await expect(ws.writeInput(ID, bad, Buffer.from('x'))).rejects.toBeInstanceOf(WorkspaceError);
    }
    await expect(ws.writeInput(ID, 'figuras/a.png', Buffer.from('otra'))).rejects.toThrow();
    await expect(make().prepare('../x')).rejects.toBeInstanceOf(WorkspaceError);
    expect(await exists(path.join(root, 'fuera.tex'))).toBe(false);
  });
});

describe('collectArtifacts', () => {
  it('recoge PDF, log, SyncTeX y .blg válidos', async () => {
    const ws = make();
    const { outputDir } = await ws.prepare(ID);
    const pdf = Buffer.from('%PDF-1.5 contenido\x00\xff', 'latin1');
    await fs.writeFile(path.join(outputDir, 'output.pdf'), pdf);
    await fs.writeFile(path.join(outputDir, 'output.log'), 'log ok');
    await fs.writeFile(path.join(outputDir, 'output.synctex.gz'), 'gz');
    await fs.writeFile(path.join(outputDir, 'output.blg'), 'WARN - x');
    const artifacts = await ws.collectArtifacts(ID);
    expect(artifacts.pdf).toEqual(pdf);
    expect([artifacts.log?.toString(), artifacts.synctex?.toString(), artifacts.blg?.toString()]).toEqual(['log ok', 'gz', 'WARN - x']);
  });

  it('no recoge un PDF mayor que el tope y del log se queda con el final y un aviso', async () => {
    const ws = make();
    const { outputDir } = await ws.prepare(ID);
    await fs.writeFile(path.join(outputDir, 'output.pdf'), Buffer.alloc(MAX_PDF + 1, 1));
    const log = Buffer.from('0123456789'.repeat(100));
    await fs.writeFile(path.join(outputDir, 'output.log'), log);

    const artifacts = await ws.collectArtifacts(ID);
    expect([artifacts.pdf, artifacts.pdfTooLarge]).toEqual([null, true]);
    expect(artifacts.log?.toString('utf8')).toMatch(/^\[latexweb\] El log original tenía 1000 bytes/);
    expect(artifacts.log?.subarray(artifacts.log.length - MAX_LOG)).toEqual(log.subarray(log.length - MAX_LOG));
  });

  it('no recoge directorios', async () => {
    const ws = make();
    const { outputDir } = await ws.prepare(ID);
    await fs.mkdir(path.join(outputDir, 'output.pdf'));
    await fs.mkdir(path.join(outputDir, 'output.log'));
    expect(await ws.collectArtifacts(ID)).toEqual(NOTHING);
  });

  it.skipIf(!fileSymlinks)('no sigue symlinks a archivos de fuera', async () => {
    const ws = make();
    const { outputDir } = await ws.prepare(ID);
    const secret = path.join(base, 'secret');
    await fs.writeFile(secret, 'SECRETO');
    for (const name of ['output.pdf', 'output.log', 'output.synctex.gz', 'output.blg']) {
      await fs.symlink(secret, path.join(outputDir, name), 'file');
    }
    expect(await ws.collectArtifacts(ID)).toEqual(NOTHING);
  });
});

describe('cleanup y sweepExpired', () => {
  it('cleanup borra todo el trabajo de la compilación y es idempotente', async () => {
    const ws = make();
    await ws.prepare(ID);
    await ws.cleanup(ID);
    await ws.cleanup(ID);
    expect(await exists(path.join(root, ID))).toBe(false);
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

describe('prepareWorkRoot', () => {
  it('crea la raíz y rechaza un archivo o un enlace en su lugar', async () => {
    const created = path.join(base, 'a', 'raiz');
    await prepareWorkRoot(created);
    expect((await fs.lstat(created)).isDirectory()).toBe(true);

    const file = path.join(base, 'archivo');
    await fs.writeFile(file, 'x');
    await expect(prepareWorkRoot(file)).rejects.toThrow();

    const link = path.join(base, 'enlace');
    await fs.symlink(created, link, 'junction');
    await expect(prepareWorkRoot(link)).rejects.toBeInstanceOf(WorkspaceError);
  });
});
