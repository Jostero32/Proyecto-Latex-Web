import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalCompilationsStorage, StorageError, type CompilationsStorage } from './storage';

let root: string;
let storage: CompilationsStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'latexweb-storage-test-'));
  storage = createLocalCompilationsStorage(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function readAll(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

describe('saveInputs', () => {
  it('escribe archivos en subcarpetas con su contenido', async () => {
    const id = randomUUID();
    await storage.saveInputs(id, [
      { path: 'main.tex', data: Buffer.from('hola') },
      { path: 'figuras/sub/a.png', data: Buffer.from([1, 2, 3]) },
    ]);
    expect(await readFile(join(root, id, 'input', 'main.tex'), 'utf8')).toBe('hola');
    expect([...(await readFile(join(root, id, 'input', 'figuras', 'sub', 'a.png')))]).toEqual([1, 2, 3]);
  });

  it('lanza StorageError con un id que no es uuid', async () => {
    await expect(storage.saveInputs('../x', [{ path: 'a.tex', data: Buffer.from('') }])).rejects.toBeInstanceOf(StorageError);
  });

  it('no sobrescribe un archivo existente', async () => {
    const id = randomUUID();
    await storage.saveInputs(id, [{ path: 'main.tex', data: Buffer.from('uno') }]);
    await expect(storage.saveInputs(id, [{ path: 'main.tex', data: Buffer.from('dos') }])).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(join(root, id, 'input', 'main.tex'), 'utf8')).toBe('uno');
  });
});

describe('openArtifact', () => {
  it('devuelve stream y tamaño de output.pdf y output.log', async () => {
    const id = randomUUID();
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, 'output.pdf'), 'PDFDATA');
    await writeFile(join(root, id, 'output.log'), 'log');

    const pdf = await storage.openArtifact(id, 'pdf');
    expect(pdf?.size).toBe(7);
    expect(await readAll(pdf!.stream)).toBe('PDFDATA');
    const log = await storage.openArtifact(id, 'log');
    expect(log?.size).toBe(3);
    expect(await readAll(log!.stream)).toBe('log');
  });

  it('null si no existe', async () => {
    expect(await storage.openArtifact(randomUUID(), 'pdf')).toBeNull();
    const id = randomUUID();
    await mkdir(join(root, id), { recursive: true });
    expect(await storage.openArtifact(id, 'log')).toBeNull();
  });

  it('null si es un directorio', async () => {
    const id = randomUUID();
    await mkdir(join(root, id, 'output.pdf'), { recursive: true });
    expect(await storage.openArtifact(id, 'pdf')).toBeNull();
  });
});

describe('remove', () => {
  it('borra todo y es idempotente', async () => {
    const id = randomUUID();
    await storage.saveInputs(id, [{ path: 'a/b.tex', data: Buffer.from('x') }]);
    await storage.remove(id);
    expect(await exists(join(root, id))).toBe(false);
    await expect(storage.remove(id)).resolves.toBeUndefined();
  });
});
