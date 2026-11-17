// Tipos y constantes de la compilación compartidos entre server, compiler y web.
// TS puro: no usar APIs de Node aquí (web también importa este paquete).

export const ENGINES = ['pdflatex', 'xelatex', 'lualatex'] as const;
export type Engine = (typeof ENGINES)[number];

export const DEFAULT_ENGINE: Engine = 'pdflatex';
export const DEFAULT_MAIN_FILE = 'main.tex';

/** Artefactos que se pueden descargar (latexmk corre con -jobname=output). */
export const ARTIFACT_FILES = { pdf: 'output.pdf', log: 'output.log', synctex: 'output.synctex.gz' } as const;
export type ArtifactKind = keyof typeof ARTIFACT_FILES;
export const ARTIFACT_KINDS = Object.keys(ARTIFACT_FILES) as ArtifactKind[];

/**
 * Claves en el bucket. El server escribe la instantánea del proyecto en `input/`; el compiler la
 * baja, compila y sube los artefactos. Una regla de ciclo de vida borra `compilations/` al día.
 */
export const COMPILATIONS_PREFIX = 'compilations/';
export const compilationInputPrefix = (id: string) => `${COMPILATIONS_PREFIX}${id}/input/`;
export const compilationArtifactKey = (id: string, kind: ArtifactKind) => `${COMPILATIONS_PREFIX}${id}/${ARTIFACT_FILES[kind]}`;

/** Payload del job en la cola `compile`. Los archivos nunca viajan por Redis. */
export interface CompileJobData {
  compilationId: string;
  mainFile: string;
  engine: Engine;
}

export type CompileOutcome = 'success' | 'error' | 'timeout';

/** Por qué no hay PDF: la compilación no lo generó, o lo generó pero superaba el tamaño máximo. */
export type PdfMissingReason = 'not_produced' | 'too_large';

export type DiagnosticLevel = 'error' | 'warning' | 'info';

/** Un error o aviso del log de LaTeX o de biber/bibtex. `file` es una ruta del proyecto, si se sabe. */
export interface Diagnostic {
  file: string | null;
  line: number | null;
  level: DiagnosticLevel;
  message: string;
}

/** Lo que devuelve el processor. Un error de LaTeX es un resultado, no una excepción. */
export interface CompileJobResult {
  outcome: CompileOutcome;
  exitCode: number | null;
  durationMs: number;
  hasPdf: boolean;
  hasLog: boolean;
  hasSynctex: boolean;
  /** null si se publicó un PDF. */
  pdfMissingReason: PdfMissingReason | null;
  diagnostics: Diagnostic[];
}

/** `failed` = fallo de infraestructura (no de LaTeX). */
export type CompilationStatus = 'queued' | 'running' | CompileOutcome | 'failed';

export interface Compilation {
  id: string;
  projectId: string;
  status: CompilationStatus;
  engine: Engine;
  mainFile: string;
  createdAt: string;
  finishedAt?: string;
  /** Desde aquí los artefactos ya no se pueden descargar. */
  expiresAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  pdfMissingReason?: PdfMissingReason | null;
  diagnostics?: Diagnostic[];
  pdfUrl?: string;
  logUrl?: string;
  synctexUrl?: string;
}

export interface CompilationResponse {
  compilation: Compilation;
}

export type CompilationErrorCode =
  | 'not_found'
  | 'invalid_main_file'
  | 'queue_full'
  | 'not_ready'
  | 'artifact_not_available'
  | 'pdf_too_large'
  | 'expired';

export function isEngine(value: unknown): value is Engine {
  return typeof value === 'string' && (ENGINES as readonly string[]).includes(value);
}
