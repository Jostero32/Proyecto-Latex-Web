import { describe, expect, it } from 'vitest';
import {
  detectEngineFromSource,
  findPathCollision,
  isCompilationId,
  isIgnoredPath,
  isValidMainFile,
  isWindowsReservedName,
  normalizeProjectPath,
  type PathRejectReason,
} from '../src/project-paths';

const levels = (n: number): string => Array.from({ length: n }, (_, i) => `d${i}`).join('/');
const exactly255 = `${'a'.repeat(251)}.tex`;

describe('normalizeProjectPath: rutas válidas', () => {
  it.each<[string, string]>([
    ['main.tex', 'main.tex'],
    ['cap/intro.tex', 'cap/intro.tex'],
    ['figuras/degradado.png', 'figuras/degradado.png'],
    ['capítulo 1.tex', 'capítulo 1.tex'],
    ['10 niveles', levels(10)],
    ['255 caracteres', exactly255],
    ['main.aux', 'main.aux'],
  ])('acepta %s', (_name, input) => {
    expect(normalizeProjectPath(input)).toEqual({ ok: true, path: input });
  });

  it('las rutas de prueba tienen el tamaño esperado', () => {
    expect(exactly255).toHaveLength(255);
    expect(levels(10).split('/')).toHaveLength(10);
  });

  it('normaliza NFD a NFC', () => {
    expect(normalizeProjectPath('cafe\u0301.tex')).toEqual({ ok: true, path: 'caf\u00e9.tex' });
  });

  it('el largo máximo se mide tras NFC', () => {
    // NFD: 257 unidades UTF-16; NFC: 254.
    const nfd = `${'a'.repeat(100)}/${'b'.repeat(150)}${'e\u0301'.repeat(3)}`;
    expect(nfd).toHaveLength(257);
    expect(normalizeProjectPath(nfd)).toEqual({
      ok: true,
      path: `${'a'.repeat(100)}/${'b'.repeat(150)}${'\u00e9'.repeat(3)}`,
    });
  });

  it('un segmento CJK de exactamente 255 bytes es válido', () => {
    const name = '漢'.repeat(85);
    // 85 caracteres x 3 bytes UTF-8 = 255 bytes.
    expect(normalizeProjectPath(name)).toEqual({ ok: true, path: name });
  });
});

describe('normalizeProjectPath: rutas inválidas', () => {
  it.each<[string, string, PathRejectReason]>([
    ['vacía', '', 'empty'],
    ['256 caracteres', `${'a'.repeat(252)}.tex`, 'too_long'],

    ['raíz POSIX', '/etc/passwd', 'absolute'],
    ['UNC', '//srv/x', 'absolute'],
    ['unidad con barra', 'C:/x', 'absolute'],
    ['unidad sin barra', 'c:x', 'absolute'],

    ['barra invertida con ..', '..\\x', 'forbidden_character'],
    ['barra invertida', 'a\\b', 'forbidden_character'],
    ['dos puntos en carpeta', 'dir/a:b', 'forbidden_character'],
    ['dos puntos tras varias letras', 'ab:c', 'forbidden_character'],
    ['flujo NTFS', 'main.tex:stream', 'forbidden_character'],
    ['<', 'a<b', 'forbidden_character'],
    ['>', 'a>b', 'forbidden_character'],
    ['|', 'a|b', 'forbidden_character'],
    ['?', 'a?b', 'forbidden_character'],
    ['*', 'a*b', 'forbidden_character'],
    ['comillas', 'a"b', 'forbidden_character'],
    ['NUL', 'a\u0000b', 'forbidden_character'],
    ['salto de línea', 'a\nb', 'forbidden_character'],
    ['tabulación', 'a\tb', 'forbidden_character'],
    ['DEL', 'a\x7fb', 'forbidden_character'],
    ['control C1', 'a\u0085b', 'forbidden_character'],

    ['padre', '../x', 'invalid_segment'],
    ['padre intermedio', 'a/../b', 'invalid_segment'],
    ['punto inicial', './a', 'invalid_segment'],
    ['segmento vacío', 'a//b', 'invalid_segment'],
    ['barra final', 'a/', 'invalid_segment'],
    ['punto final', 'a.', 'invalid_segment'],
    ['espacio final', 'a ', 'invalid_segment'],
    ['carpeta con punto final', 'a./b.tex', 'invalid_segment'],
    ['solo ..', '..', 'invalid_segment'],

    ['11 niveles', levels(11), 'too_deep'],

    ['100 CJK (300 bytes)', `${'漢'.repeat(100)}.tex`, 'too_long'],
    ['85 CJK + .tex (259 bytes)', `${'漢'.repeat(85)}.tex`, 'too_long'],
  ])('rechaza %s', (_name, input, reason) => {
    expect(normalizeProjectPath(input)).toEqual({ ok: false, reason });
  });

  it('el segmento CJK largo tiene menos de 255 caracteres', () => {
    expect(`${'漢'.repeat(100)}.tex`.length).toBeLessThan(255);
  });
});

describe('nombres reservados', () => {
  it.each([
    'CON',
    'con.tex',
    'Aux.tex',
    'NUL.txt',
    'COM1',
    'lpt9.log',
    'COM¹',
    'con .tex',
    'carpeta/aux.tex',
    'PRN',
    'com3.tar.gz',
  ])('%s es reservado', (input) => {
    expect(normalizeProjectPath(input)).toEqual({ ok: false, reason: 'reserved_name' });
  });

  it.each(['main.aux', 'console.tex', 'com10.tex', 'auxiliar.tex', 'COM0', 'LPT0', 'a.con'])(
    '%s no es reservado',
    (input) => {
      expect(normalizeProjectPath(input)).toEqual({ ok: true, path: input });
    },
  );

  it.each<[string, boolean]>([
    ['CON', true],
    ['con .tex', true],
    ['COM²', true],
    ['COM0', false],
    ['com10.tex', false],
    ['', false],
  ])('isWindowsReservedName(%j) = %s', (input, expected) => {
    expect(isWindowsReservedName(input)).toBe(expected);
  });
});

describe('findPathCollision', () => {
  it.each<[string, string[]]>([
    ['lista vacía', []],
    ['una ruta', ['main.tex']],
    ['rutas distintas', ['main.tex', 'cap/intro.tex', 'cap/fin.tex']],
    ['prefijo de texto, no de carpeta', ['a', 'ab/c']],
    ['carpeta compartida', ['a/x', 'a/y']],
  ])('sin colisiones: %s', (_name, paths) => {
    expect(findPathCollision(paths)).toBeNull();
  });

  it.each<[string, string[], { path: string; conflictsWith: string }]>([
    ['duplicado exacto', ['main.tex', 'main.tex'], { path: 'main.tex', conflictsWith: 'main.tex' }],
    ['solo mayúsculas', ['Main.tex', 'main.tex'], { path: 'main.tex', conflictsWith: 'Main.tex' }],
    ['NFC/NFD', ['caf\u00e9.tex', 'cafe\u0301.tex'], { path: 'cafe\u0301.tex', conflictsWith: 'caf\u00e9.tex' }],
    ['NFD/NFC', ['cafe\u0301.tex', 'caf\u00e9.tex'], { path: 'caf\u00e9.tex', conflictsWith: 'cafe\u0301.tex' }],
  ])('duplicado: %s', (_name, paths, expected) => {
    expect(findPathCollision(paths)).toEqual({ kind: 'duplicate', ...expected });
  });

  it.each<[string, string[], { path: string; conflictsWith: string }]>([
    ['archivo y luego carpeta', ['a', 'a/b'], { path: 'a/b', conflictsWith: 'a' }],
    ['carpeta y luego archivo', ['a/b', 'a'], { path: 'a/b', conflictsWith: 'a' }],
    ['sin distinguir mayúsculas', ['Fig', 'fig/x.png'], { path: 'fig/x.png', conflictsWith: 'Fig' }],
    ['sin distinguir mayúsculas, otro orden', ['fig/x.png', 'Fig'], { path: 'fig/x.png', conflictsWith: 'Fig' }],
    ['carpeta anidada', ['a/b', 'a/b/c.tex'], { path: 'a/b/c.tex', conflictsWith: 'a/b' }],
  ])('archivo y carpeta: %s', (_name, paths, expected) => {
    expect(findPathCollision(paths)).toEqual({ kind: 'file_directory_conflict', ...expected });
  });
});

describe('isIgnoredPath', () => {
  it.each(['latexmkrc', 'LatexMkRc', 'sub/latexmkrc', '.latexmkrc', '.git/config', 'a/.DS_Store'])(
    'ignora %s',
    (input) => {
      expect(isIgnoredPath(input)).toBe(true);
    },
  );

  it.each(['main.tex', 'latexmkrc.tex', 'latexmkrc/notas.tex', 'mi.latexmkrc'])('no ignora %s', (input) => {
    expect(isIgnoredPath(input)).toBe(false);
  });
});

describe('isValidMainFile', () => {
  it.each(['main.tex', 'tesis/main.tex', 'cap_1/doc-v2.tex', 'a.b.tex', '_x.tex', '1.tex'])(
    'acepta %s',
    (input) => {
      expect(isValidMainFile(input)).toBe(true);
    },
  );

  it.each([
    '-e.tex',
    'sub/-e.tex',
    '-x/main.tex',
    'a"b.tex',
    'x$y.tex',
    'a`b.tex',
    'a;b.tex',
    'mi doc.tex',
    'capítulo.tex',
    'main.TEX',
    'main.Tex',
    'main.txt',
    '.tex',
    '/main.tex',
    '../main.tex',
    'main.tex/',
    'a//main.tex',
    'a.b/main.tex',
    '',
    `${'a'.repeat(252)}.tex`,
    'a\\b.tex',
    'main.tex\n',
  ])('rechaza %j', (input) => {
    expect(isValidMainFile(input)).toBe(false);
  });

  it('acepta exactamente 255 caracteres y rechaza 256', () => {
    expect(isValidMainFile(exactly255)).toBe(true);
    expect(isValidMainFile(`a${exactly255}`)).toBe(false);
  });

  it('acepta 10 niveles y rechaza 11', () => {
    expect(isValidMainFile(`${levels(9)}/main.tex`)).toBe(true);
    expect(isValidMainFile(`${levels(10)}/main.tex`)).toBe(false);
  });
});

describe('detectEngineFromSource', () => {
  it.each<[string, string, string | null]>([
    ['xelatex con espacios', '% !TEX program = xelatex\n\\documentclass{article}', 'xelatex'],
    ['TS-program y mayúsculas del valor', '%!TEX TS-program = LuaLaTeX\n', 'lualatex'],
    ['TeX en otra capitalización', '% !TeX program=pdflatex\n', 'pdflatex'],
    ['BOM', '\uFEFF% !TEX program = xelatex\n', 'xelatex'],
    ['líneas en blanco antes', '\n\n  \n% !TEX program = lualatex\n', 'lualatex'],
    ['comentarios antes', '% autor\n% otro\n% !TEX program = xelatex\n', 'xelatex'],
    ['CRLF', '% autor\r\n% !TEX program = xelatex\r\n\\documentclass{article}\r\n', 'xelatex'],
    ['CR solo', '% autor\r% !TEX program = lualatex\r', 'lualatex'],
    ['sin salto de línea final', '% !TEX program = xelatex', 'xelatex'],
    ['espacios finales', '% !TEX program = xelatex   \n', 'xelatex'],
    ['desconocido y luego válido', '% !TEX program = latex\n% !TEX program = xelatex\n', 'xelatex'],
    ['línea 50', `${'%\n'.repeat(49)}% !TEX program = xelatex\n`, 'xelatex'],

    ['después de código', '\\documentclass{article}\n% !TEX program = xelatex\n', null],
    ['motor latex', '% !TEX program = latex\n', null],
    ['motor context', '% !TEX program = context\n', null],
    ['línea 51', `${'%\n'.repeat(50)}% !TEX program = xelatex\n`, null],
    ['sin comentario', '\\documentclass{article}\n', null],
    ['solo comentarios normales', '% hola\n', null],
    ['vacío', '', null],
    ['motor con sufijo', '% !TEX program = xelatexx\n', null],
  ])('%s', (_name, source, expected) => {
    expect(detectEngineFromSource(source)).toBe(expected);
  });
});

describe('isCompilationId', () => {
  const uuid = '3b241101-e2bb-4255-8caf-4136c566a962';

  it.each([uuid, 'f47ac10b-58cc-4372-a567-0e02b2c3d479', '00000000-0000-4000-8000-000000000000'])(
    'acepta %s',
    (input) => {
      expect(isCompilationId(input)).toBe(true);
    },
  );

  it.each<[string, string]>([
    ['mayúsculas', uuid.toUpperCase()],
    ['v1', 'c232ab00-9414-11ec-b3c8-9e6bdeced846'],
    ['variante inválida', '3b241101-e2bb-4255-7caf-4136c566a962'],
    ['sin guiones', uuid.replaceAll('-', '')],
    ['con ../', `../${uuid}`],
    ['con sufijo', `${uuid}/..`],
    ['con salto de línea', `${uuid}\n`],
    ['no hexadecimal', 'zb241101-e2bb-4255-8caf-4136c566a962'],
    ['vacío', ''],
  ])('rechaza %s', (_name, input) => {
    expect(isCompilationId(input)).toBe(false);
  });
});
