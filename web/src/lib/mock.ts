// Datos de ejemplo del paso 1 (docs/specs/frontend.md): la interfaz todavía no llama a la API. Usan los
// contratos de @latexweb/shared para que conectar la API sea cambiar la fuente, no los componentes.
import type { Diagnostic, ProjectFile, ProjectMember, ProjectSummary, ShareLink } from '@latexweb/shared';
import { COLLABORATOR_COLORS, type Presence } from '../components/Avatar';

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();
const inDays = (days: number) => new Date(Date.now() + days * 1440 * MINUTE).toISOString();

export const CURRENT_USER = {
  id: 'u-ana',
  name: 'Ana Torres',
  email: 'ana.torres@universidad.edu',
  color: COLLABORATOR_COLORS[0],
};

const project = (id: string, name: string, role: ProjectSummary['role'], minutesAgo: number): ProjectSummary => ({
  id,
  name,
  role,
  mainFile: 'main.tex',
  engine: 'pdflatex',
  createdAt: ago(minutesAgo + 60 * 24 * 30),
  updatedAt: ago(minutesAgo),
});

export const PROJECTS: ProjectSummary[] = [
  project('erosion', 'Erosión del suelo en laderas andinas', 'owner', 12),
  project('tesis', 'Tesis de maestría: modelos hidrológicos de cuencas de montaña con datos satelitales', 'editor', 190),
  project('analisis', 'Apuntes de Análisis II', 'owner', 60 * 26),
  project('congreso', 'Paper congreso AAGG 2026', 'viewer', 60 * 24 * 4),
  project('clase7', 'Clase 7: integrales dobles (diapositivas)', 'owner', 60 * 24 * 15),
  project('cv', 'CV académico', 'owner', 60 * 24 * 62),
];

export function findProject(id: string | undefined): ProjectSummary {
  return PROJECTS.find((p) => p.id === id) ?? PROJECTS[0]!;
}

const file = (path: string, kind: ProjectFile['kind'], size: number): ProjectFile => ({ id: path, path, kind, size, updatedAt: ago(30) });

export const FILES: ProjectFile[] = [
  file('main.tex', 'text', 2_480),
  file('referencias.bib', 'text', 5_120),
  file('capitulos/introduccion.tex', 'text', 3_870),
  file('capitulos/metodologia/procedimiento-de-campo.tex', 'text', 6_210),
  file('figuras/diagrama-final.png', 'binary', 319_488),
  file('figuras/fotos-campo-microcuenca-norte-2026.jpg', 'binary', 4_404_019),
  file('figuras/mapa-pendientes.pdf', 'binary', 1_258_291),
  file('plantilla-revista.cls', 'text', 9_830),
];

export const MEMBERS: ProjectMember[] = [
  { userId: 'u-ana', name: 'Ana Torres', email: 'ana.torres@universidad.edu', role: 'owner' },
  { userId: 'u-lucia', name: 'Lucía Paredes', email: 'lucia.paredes@universidad.edu', role: 'editor' },
  { userId: 'u-mateo', name: 'Mateo Ríos', email: 'mateo.rios@universidad.edu', role: 'editor' },
  { userId: 'u-sofia', name: null, email: 's.vega.investigacion.suelos.2026@correo-institucional.edu', role: 'viewer' },
];

export const SHARE_LINKS: ShareLink[] = [
  { id: 'l1', role: 'viewer', createdAt: ago(60 * 24 * 7), expiresAt: inDays(23) },
  { id: 'l2', role: 'editor', createdAt: ago(60 * 24 * 15), expiresAt: null },
];

/** Token de ejemplo: el real lo devuelve el server una sola vez. */
export const SAMPLE_TOKEN = 'Qm7rT2xV9pLk4sW8dZ3nH6yBcE';

export interface RemoteCursor {
  name: string;
  color: string;
  line: number;
  column: number;
  /** Columna donde arranca la selección, si hay. */
  selectionFrom?: number;
}

export const PRESENCE: Presence[] = [
  { name: CURRENT_USER.name, email: CURRENT_USER.email, color: CURRENT_USER.color, you: true },
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

/** Contenido de ejemplo de los otros archivos de texto. */
export const FILE_CONTENTS: Record<string, string[]> = {
  'referencias.bib': [
    '@book{renard1997,',
    '  author    = {Renard, K. G. and Foster, G. R. and Weesies, G. A.},',
    '  title     = {Predicting Soil Erosion by Water},',
    '  publisher = {USDA},',
    '  year      = {1997}',
    '}',
  ],
  'capitulos/introduccion.tex': [
    '% Capítulo de introducción',
    'Las laderas andinas combinan pendientes fuertes con lluvias intensas',
    'concentradas en pocos meses \\cite{knuth1984}.',
  ],
  'capitulos/metodologia/procedimiento-de-campo.tex': ['\\subsection{Procedimiento de campo}', 'Medimos la pérdida de suelo en parcelas de escurrimiento.'],
  'plantilla-revista.cls': ['\\NeedsTeXFormat{LaTeX2e}', '\\ProvidesClass{plantilla-revista}', '\\LoadClass[11pt]{article}'],
};
