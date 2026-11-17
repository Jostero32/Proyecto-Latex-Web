// Datos de demostración del editor (`?vista=exito|errores`): colaboradores, documento y diagnósticos del
// diseño, para ver lo que todavía no está conectado (presencia y cursores: paso 3; compilar: paso 4).
import type { Diagnostic } from '@latexweb/shared';
import { COLLABORATOR_COLORS, type Presence } from '../components/Avatar';

export interface RemoteCursor {
  name: string;
  color: string;
  line: number;
  column: number;
  /** Columna donde arranca la selección, si hay. */
  selectionFrom?: number;
}

/** Otras personas en el proyecto (vos vas primero, con tu cuenta). */
export const PRESENCE: Presence[] = [
  { name: 'Lucía Paredes', email: 'lucia.paredes@universidad.edu', color: COLLABORATOR_COLORS[1], file: 'main.tex' },
  { name: 'Mateo Ríos', email: 'mateo.rios@universidad.edu', color: COLLABORATOR_COLORS[2], file: 'main.tex' },
];

export const REMOTE_CURSORS: RemoteCursor[] = [
  { name: 'Lucía', color: COLLABORATOR_COLORS[1], line: 22, column: 39, selectionFrom: 11 },
  { name: 'Mateo', color: COLLABORATOR_COLORS[2], line: 10, column: 53 },
];

export const DOCUMENT = [
  '\\documentclass[11pt,a4paper]{article}',
  '\\usepackage[spanish]{babel}',
  '\\usepackage{amsmath, amssymb}',
  '\\usepackage{graphicx}',
  '\\usepackage{booktabs}',
  '\\usepackage[backend=biber]{biblatex}',
  '\\addbibresource{referencias.bib}',
  '',
  '\\title{Erosión del suelo en laderas andinas}',
  '\\author{Ana Torres \\and Lucía Paredes \\and Mateo Ríos}',
  '\\date{\\today}',
  '',
  '\\begin{document}',
  '\\maketitle',
  '',
  '\\begin{abstract}',
  '  Estimamos la pérdida de suelo en tres microcuencas',
  '  con la ecuación universal revisada (RUSLE).',
  '\\end{abstract}',
  '',
  '\\section{Introducción}',
  'La erosión hídrica depende de la lluvia, el suelo,',
  'la pendiente y la cobertura \\cite{renard1997}.',
  'La pérdida anual se estima como',
  '\\begin{equation}',
  '  A = R \\cdot K \\cdot LS \\cdot C \\cdot P',
  '\\end{equation}',
  'donde $A$ está en t/ha por año. Ver la Tabla~\\ref{tab:res}.',
  '',
  '\\input{capitulos/introduccion}',
  '% Figura de las microcuencas (la arma Lucía)',
  '\\begin{figure}[h]',
  '  \\centering',
  '  \\includegraphics[width=.8\\linewidth]{figuras/diagrama-final}',
  '  \\caption{Microcuencas estudiadas.}',
  '\\end{figure}',
  '',
  '\\printbibliography',
  '\\end{document}',
];

/** El mismo documento con los dos errores de la vista "errores" (líneas 5 y 28). */
export const DOCUMENT_WITH_ERRORS = DOCUMENT.map((line, index) => {
  if (index === 4) return '\\usepackage{bookstabs}';
  if (index === 27) return 'donde $A$ está en t/ha por año. Ver la \\tabla{res}.';
  return line;
});

const OVERFULL: Diagnostic = {
  level: 'warning',
  message: 'Overfull \\hbox (14.2pt too wide) in paragraph at lines 40--42',
  file: 'capitulos/metodologia/procedimiento-de-campo.tex',
  line: 40,
};

export const DIAGNOSTICS_SUCCESS: Diagnostic[] = [OVERFULL];

export const DIAGNOSTICS_ERRORS: Diagnostic[] = [
  { level: 'error', message: 'Undefined control sequence. l.28 ...Ver la \\tabla', file: 'main.tex', line: 28 },
  { level: 'error', message: "LaTeX Error: File `bookstabs.sty' not found.", file: 'main.tex', line: 5 },
  { level: 'warning', message: "Citation 'knuth1984' on page 2 undefined on input line 22.", file: 'capitulos/introduccion.tex', line: 22 },
  OVERFULL,
  { level: 'warning', message: 'LaTeX Warning: There were undefined references.', file: null, line: null },
  { level: 'info', message: 'Package babel Info: Hyphen rules for spanish loaded.', file: null, line: null },
];

