// Diagnósticos de demostración para `?compilar=errores` (la compilación real se conecta en el paso 4).
import type { Diagnostic } from '@latexweb/shared';

const OVERFULL: Diagnostic = {
  level: 'warning',
  message: 'Overfull \\hbox (14.2pt too wide) in paragraph at lines 40--42',
  file: 'capitulos/metodologia/procedimiento-de-campo.tex',
  line: 40,
};

export const DIAGNOSTICS_ERRORS: Diagnostic[] = [
  { level: 'error', message: 'Undefined control sequence. l.28 ...Ver la \\tabla', file: 'main.tex', line: 28 },
  { level: 'error', message: "LaTeX Error: File `bookstabs.sty' not found.", file: 'main.tex', line: 5 },
  { level: 'warning', message: "Citation 'knuth1984' on page 2 undefined on input line 22.", file: 'capitulos/introduccion.tex', line: 22 },
  OVERFULL,
  { level: 'warning', message: 'LaTeX Warning: There were undefined references.', file: null, line: null },
  { level: 'info', message: 'Package babel Info: Hyphen rules for spanish loaded.', file: null, line: null },
];

