// Tipos y constantes del flujo de compilación compartidos entre api, compiler y web.
// TS puro: no usar APIs de Node aquí (web también importa este paquete).

export const ENGINES = ['pdflatex', 'xelatex', 'lualatex'] as const;
export type Engine = (typeof ENGINES)[number];

export const DEFAULT_ENGINE: Engine = 'pdflatex';
export const DEFAULT_MAIN_FILE = 'main.tex';

/** Nombres fijos de los artefactos publicados (latexmk corre con -jobname=output). */
export const ARTIFACT_FILES = { pdf: 'output.pdf', log: 'output.log' } as const;
export type ArtifactKind = keyof typeof ARTIFACT_FILES;

/** Payload del job en la cola `compile`. Los archivos nunca viajan por Redis. */
export interface CompileJobData {
  compilationId: string;
  mainFile: string;
  engine: Engine;
}

export type CompileOutcome = 'success' | 'error' | 'timeout';

/** Por qué no hay PDF: la compilación no lo generó, o lo generó pero superaba el tamaño máximo. */
export type PdfMissingReason = 'not_produced' | 'too_large';

/** Lo que devuelve el processor. Un error de LaTeX es un resultado, no una excepción. */
export interface CompileJobResult {
  outcome: CompileOutcome;
  exitCode: number | null;
  durationMs: number;
  hasPdf: boolean;
  hasLog: boolean;
  /** null si se publicó un PDF. */
  pdfMissingReason: PdfMissingReason | null;
}

/** `failed` = fallo de infraestructura (no de LaTeX). */
export type CompilationStatus = 'queued' | 'running' | CompileOutcome | 'failed';

export interface CreateCompilationResponse {
  id: string;
  status: 'queued';
  engine: Engine;
  mainFile: string;
  ignoredFiles: string[];
}

export interface CompilationStatusResponse {
  id: string;
  status: CompilationStatus;
  engine: Engine;
  mainFile: string;
  createdAt: string;
  finishedAt?: string;
  expiresAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  pdfMissingReason?: PdfMissingReason | null;
  pdfUrl?: string;
  logUrl?: string;
}

export type CompilationErrorCode =
  | 'invalid_path'
  | 'duplicate_path'
  | 'no_files'
  | 'too_many_files'
  | 'file_too_large'
  | 'payload_too_large'
  | 'main_file_missing'
  | 'invalid_main_file'
  | 'invalid_engine'
  | 'queue_full'
  | 'not_found'
  | 'not_ready'
  | 'artifact_not_available'
  | 'pdf_too_large'
  | 'expired';

/** Nombre de la carpeta de almacenamiento por defecto dentro del directorio temporal del sistema. */
export const DEFAULT_STORAGE_DIRNAME = 'latexweb-compilations';

export interface ApiError {
  error: CompilationErrorCode;
  message: string;
}

export function isEngine(value: unknown): value is Engine {
  return typeof value === 'string' && (ENGINES as readonly string[]).includes(value);
}
