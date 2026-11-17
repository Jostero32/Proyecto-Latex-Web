// Diagnósticos a partir del log de LaTeX y del .blg de biber/bibtex.
import { describe, expect, it } from 'vitest';
import { MAX_DIAGNOSTICS, parseBlg, parseLatexLog, projectPath } from '../src/log';

const LOG = String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2026) (preloaded format=pdflatex 2026.1.1)  1 JAN 2026 12:00
entering extended mode
(./main.tex
LaTeX2e <2025-11-01>
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Document Class: article 2024/06/29 v1.4n Standard LaTeX document class
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size10.clo))
(./capitulos/intro.tex
LaTeX Warning: Reference ${'`'}fig:x' on page 1 undefined on input line 7.

Overfull \hbox (12.0pt too wide) in paragraph at lines 9--10
[]\OT1/cmr/m/n/10 texto
 []

)
./main.tex:12: Undefined control sequence.
l.12 \foo

./main.tex:13: LaTeX Error: File ${'`'}inexistente.sty' not found.
Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing ${'`'}\textbf' on input line 20.

LaTeX Warning: There were undefined references.

! Emergency stop.
)`;

describe('parseLatexLog', () => {
  it('errores con archivo y línea, avisos con el archivo abierto en ese momento, y cajas como info', () => {
    expect(parseLatexLog(LOG)).toEqual([
      { file: 'main.tex', line: 12, level: 'error', message: 'Undefined control sequence.' },
      { file: 'main.tex', line: 13, level: 'error', message: "File `inexistente.sty' not found." },
      { file: 'capitulos/intro.tex', line: 7, level: 'warning', message: "Reference `fig:x' on page 1 undefined" },
      { file: 'main.tex', line: 20, level: 'warning', message: "hyperref: Token not allowed in a PDF string (Unicode): removing `\\textbf'" },
      { file: 'main.tex', line: null, level: 'warning', message: 'There were undefined references' },
      { file: 'capitulos/intro.tex', line: 9, level: 'info', message: 'Overfull \\hbox (12.0pt too wide)' },
    ]);
  });

  it('un error sin -file-line-error toma la línea de l.N; repetidos y exceso se recortan', () => {
    expect(parseLatexLog('(./main.tex\n! Missing $ inserted.\n<inserted text>\nl.5 a^b\n)')).toEqual([
      { file: 'main.tex', line: 5, level: 'error', message: 'Missing $ inserted.' },
    ]);
    const many = Array.from({ length: 300 }, (_, i) => `./main.tex:${i + 1}: Error ${i}`).join('\n');
    expect(parseLatexLog(`${many}\n${many}`)).toHaveLength(MAX_DIAGNOSTICS);
  });

  it('las rutas de TeX Live o fuera del proyecto no se informan como archivo del proyecto', () => {
    expect(projectPath('/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls')).toBeNull();
    expect(projectPath('/work/capitulos/a.tex')).toBe('capitulos/a.tex');
    expect(projectPath('./../x.tex')).toBeNull();
  });
});

describe('parseBlg', () => {
  it('biber: WARN y ERROR, con la línea si la dice', () => {
    const blg = [
      '[0] Config.pm:308> INFO - This is Biber 2.20',
      "[50] Biber.pm:4419> WARN - Duplicate entry key 'knuth' in file 'refs.bib', skipping ...",
      '[60] Utils.pm:410> ERROR - BibTeX subsystem: /tmp/biber_tmp/refs.bib_1.utf8, line 4, syntax error',
    ].join('\n');
    expect(parseBlg(blg)).toEqual([
      { file: null, line: 4, level: 'error', message: 'BibTeX subsystem: /tmp/biber_tmp/refs.bib_1.utf8, line 4, syntax error' },
      { file: null, line: null, level: 'warning', message: "Duplicate entry key 'knuth' in file 'refs.bib', skipping ..." },
    ]);
  });

  it('bibtex: Warning-- y errores con ---line N of file', () => {
    const blg = 'Warning--I didn\'t find a database entry for "x"\nI was expecting a `,\' or a `}\'---line 5 of file refs.bib\n :';
    expect(parseBlg(blg)).toEqual([
      { file: 'refs.bib', line: 5, level: 'error', message: "I was expecting a `,' or a `}'" },
      { file: null, line: null, level: 'warning', message: 'I didn\'t find a database entry for "x"' },
    ]);
  });
});
