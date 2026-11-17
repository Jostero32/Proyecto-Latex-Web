// Zips maliciosos o raros al importar: se rechazan antes de descomprimir, sin escribir nada.
import { describe, expect, it } from 'vitest';
import type { ProjectLimits } from '../src/features/files/service';
import { readZip } from '../src/features/projects/zip';
import { makeZip, patchZip } from './helpers';

const LIMITS: ProjectLimits = { maxBytes: 10_000, maxFiles: 5, fileMaxBytes: 8_000 };

async function rejection(zip: Buffer, limits = LIMITS) {
  return readZip(zip, limits).then(
    () => null,
    (error: { statusCode: number; code: string }) => ({ status: error.statusCode, code: error.code }),
  );
}

describe('readZip', () => {
  it('quita la carpeta raíz común e ignora __MACOSX, ocultos, latexmkrc y carpetas', async () => {
    const zip = await makeZip([
      { name: 'tesis/main.tex', data: 'hola' },
      { name: 'tesis/figuras/a.png', data: Buffer.from([0x89, 0x50]) },
      { name: 'tesis/.DS_Store' },
      { name: 'tesis/latexmkrc' },
      { name: '__MACOSX/tesis/._main.tex' },
    ]);
    const files = await readZip(zip, LIMITS);
    expect(files.map((f) => [f.path, f.data.toString('hex')])).toEqual([
      ['main.tex', Buffer.from('hola').toString('hex')],
      ['figuras/a.png', '8950'],
    ]);
  });

  it.each([
    ['una ruta con ..', async () => patchZip(await makeZip([{ name: 'xx/evil.tex' }]), 'xx/evil.tex', '../evil.tex')],
    ['una ruta absoluta', async () => patchZip(await makeZip([{ name: 'xetc/passwd' }]), 'xetc/passwd', '/etc/passwd')],
    ['un symlink', () => makeZip([{ name: 'main.tex' }, { name: 'enlace.tex', data: '/etc/passwd', mode: 0o120777 }])],
    ['algo que no es un zip', async () => Buffer.from('no soy un zip')],
  ])('rechaza %s (400 invalid_zip)', async (_label, build) => {
    expect(await rejection(await build())).toEqual({ status: 400, code: 'invalid_zip' });
  });

  it('rechaza demasiados archivos y uno que se infla por encima del tope, por lo declarado', async () => {
    const many = await makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.tex` })));
    expect(await rejection(many)).toEqual({ status: 413, code: 'too_many_files' });

    // 1 MB de ceros comprime a ~1 KB.
    const bomb = await makeZip([{ name: 'bomba.txt', data: Buffer.alloc(1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(LIMITS.maxBytes);
    expect(await rejection(bomb)).toEqual({ status: 413, code: 'file_too_large' });
    const split = await makeZip([
      { name: 'a.txt', data: Buffer.alloc(6_000) },
      { name: 'b.txt', data: Buffer.alloc(6_000) },
    ]);
    expect(await rejection(split)).toEqual({ status: 413, code: 'project_too_large' });
  });

  it('rechaza un zip que miente el tamaño descomprimido', async () => {
    // El directorio central dice 4 bytes; descomprimido da 8000.
    const zip = await makeZip([{ name: 'a.txt', data: Buffer.alloc(8_000) }]);
    const lie = Buffer.from(zip);
    const central = lie.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lie.writeUInt32LE(4, central + 24);
    expect(await rejection(lie)).toEqual({ status: 400, code: 'invalid_zip' });
  });
});
