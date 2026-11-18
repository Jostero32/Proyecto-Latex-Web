// SyncTeX: rutas del contenedor a rutas del proyecto, código → PDF y PDF → código.
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { forwardSearch, inverseSearch, loadSynctex, parseSynctex } from '../src/features/editor/synctex';

const BP = 65781.76; // sp por punto del PDF
const sp = (bp: number) => Math.round(bp * BP);

// Página 1: un renglón de main.tex (párrafo que termina en la línea 12, con texto de las líneas 10 y 11)
// y uno de cap/intro.tex (línea 3); el número de página viene de article.cls, que no es del proyecto.
const SAMPLE = [
  'SyncTeX Version:1',
  'Input:1:/work/./main.tex',
  'Input:2:/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls',
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'X Offset:0',
  'Y Offset:0',
  'Content:',
  'Input:3:/work/./cap/intro.tex',
  '!120',
  '{1',
  `[1,12:${sp(72)},${sp(770)}:${sp(450)},${sp(700)},0`,
  // Un punto suelto entre párrafos (línea 5, sin renglón): no sirve para marcar.
  `x1,5:${sp(72)},${sp(80)}`,
  `(1,12:${sp(72)},${sp(100)}:${sp(450)},${sp(8)},${sp(2)}`,
  `g1,10:${sp(72)},${sp(100)}`,
  `x1,11:${sp(300)},${sp(100)}`,
  ')',
  `(3,4:${sp(72)},${sp(130)}:${sp(450)},${sp(8)},${sp(2)}`,
  `k3,3:${sp(80)},${sp(130)}:${sp(1)}`,
  ')',
  `h2,500:${sp(290)},${sp(760)}:${sp(10)},${sp(8)},0`,
  ']',
  '}1',
  'Postamble:',
].join('\n');

const PATHS = ['main.tex', 'cap/intro.tex', 'intro.tex'];

describe('SyncTeX', () => {
  const sync = parseSynctex(SAMPLE, PATHS, 'main.tex');

  it('solo reconoce los archivos del proyecto, por la carpeta del documento principal', () => {
    expect([...sync.files.values()].sort()).toEqual(['cap/intro.tex', 'main.tex']);
  });

  it('código → PDF: marca el renglón que contiene la línea, o el de la línea más cercana', () => {
    const [rect] = forwardSearch(sync, 'main.tex', 11);
    expect(rect?.page).toBe(1);
    expect(rect?.x).toBeCloseTo(72);
    expect(rect?.y).toBeCloseTo(92); // la línea de base menos la altura
    expect(rect?.height).toBeCloseTo(10);
    expect(forwardSearch(sync, 'cap/intro.tex', 1)[0]?.y).toBeCloseTo(122);
    expect(forwardSearch(sync, 'intro.tex', 1)).toEqual([]);
    // Desde el preámbulo (sin nada en el PDF): el primer renglón que sí está.
    expect(forwardSearch(sync, 'main.tex', 2)[0]?.y).toBeCloseTo(92);
  });

  it('PDF → código: el pedazo más cercano a la izquierda del clic, dentro del renglón', () => {
    expect(inverseSearch(sync, 1, 200, 97)).toEqual({ path: 'main.tex', line: 10 });
    expect(inverseSearch(sync, 1, 320, 97)).toEqual({ path: 'main.tex', line: 11 });
    expect(inverseSearch(sync, 1, 100, 127)).toEqual({ path: 'cap/intro.tex', line: 3 });
    // El número de página es de article.cls: lleva a lo más cercano del proyecto.
    expect(inverseSearch(sync, 1, 295, 755)?.path).toBeDefined();
    expect(inverseSearch(sync, 2, 100, 100)).toBeNull();
  });

  it('descomprime el .synctex.gz', async () => {
    const response = new Response(gzipSync(Buffer.from(SAMPLE)));
    expect(await loadSynctex(response)).toBe(SAMPLE);
  });
});
