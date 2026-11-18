// Validación de rutas y archivos de un proyecto subido. Funciones puras, sin APIs de Node.
// Ver docs/specs/compilacion.md, sección "Validación".
import { ENGINES, type Engine } from './compilation';

/** Largo máximo de la ruta completa, en caracteres (unidades UTF-16, tras NFC). */
export const MAX_PATH_LENGTH = 255;
/** Máximo de segmentos de una ruta (carpetas + archivo). */
export const MAX_PATH_DEPTH = 10;
/** Máximo de bytes UTF-8 por segmento (límite de nombre de ext4/NTFS). */
export const MAX_SEGMENT_BYTES = 255;

export type PathRejectReason =
  | 'empty'
  | 'too_long'
  | 'absolute'
  | 'forbidden_character'
  | 'invalid_segment'
  | 'too_deep'
  | 'reserved_name';

export type PathCheck = { ok: true; path: string } | { ok: false; reason: PathRejectReason };

// `\` (separador de Windows), `:` (unidades y flujos alternativos NTFS), caracteres prohibidos en
// Windows y cualquier carácter de control (C0, DEL y C1).
const FORBIDDEN_CHARACTERS = /[\\:<>"|?*\p{Cc}]/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
// Windows también reserva COM¹-COM³ y LPT¹-LPT³ (dígitos en superíndice).
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

/**
 * Normaliza (NFC) y valida una ruta relativa POSIX de un archivo del proyecto.
 * No resuelve `..`: cualquier segmento `.` o `..` se rechaza.
 */
export function normalizeProjectPath(raw: string): PathCheck {
  const path = raw.normalize('NFC');

  if (path.length === 0) return reject('empty');
  if (path.length > MAX_PATH_LENGTH) return reject('too_long');
  // Cubre `/x`, `//servidor/x` y `C:...`; se evalúa antes que los caracteres prohibidos
  // para que `C:/x` se informe como ruta absoluta.
  if (path.startsWith('/') || WINDOWS_DRIVE.test(path)) return reject('absolute');
  if (FORBIDDEN_CHARACTERS.test(path)) return reject('forbidden_character');

  const segments = path.split('/');
  if (segments.length > MAX_PATH_DEPTH) return reject('too_deep');

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return reject('invalid_segment');
    // Windows recorta en silencio los puntos y espacios finales: `a.tex.` y `a.tex` colisionarían.
    if (segment.endsWith('.') || segment.endsWith(' ')) return reject('invalid_segment');
    if (utf8Length(segment) > MAX_SEGMENT_BYTES) return reject('too_long');
    if (isWindowsReservedName(segment)) return reject('reserved_name');
  }

  return { ok: true, path };
}

/** `CON`, `aux.tex`, `Nul.txt`, `COM1.tar.gz`… (el nombre antes del primer punto, sin distinguir mayúsculas). */
export function isWindowsReservedName(segment: string): boolean {
  const base = (segment.split('.')[0] ?? '').trimEnd();
  return WINDOWS_RESERVED.test(base);
}

export type PathCollision = {
  kind: 'duplicate' | 'file_directory_conflict';
  path: string;
  conflictsWith: string;
};

/**
 * Busca colisiones en un conjunto de rutas ya validadas con `normalizeProjectPath`:
 * duplicados sin distinguir mayúsculas (NTFS/APFS no distinguen) y rutas que son a la vez
 * archivo y carpeta (`a` y `a/b`). Devuelve la primera colisión o `null`.
 */
export function findPathCollision(paths: readonly string[]): PathCollision | null {
  const files = new Map<string, string>();
  for (const path of paths) {
    const key = collisionKey(path);
    const previous = files.get(key);
    if (previous !== undefined) return { kind: 'duplicate', path, conflictsWith: previous };
    files.set(key, path);
  }

  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const file = files.get(collisionKey(segments.slice(0, i).join('/')));
      if (file !== undefined) return { kind: 'file_directory_conflict', path, conflictsWith: file };
    }
  }

  return null;
}

/**
 * Archivos que se aceptan pero no se escriben: cualquier segmento oculto (`.latexmkrc`, `.git/…`,
 * `.DS_Store`) y los `latexmkrc`, que latexmk ejecutaría como Perl. Espera una ruta normalizada.
 */
export function isIgnoredPath(path: string): boolean {
  const segments = path.split('/');
  const fileName = segments[segments.length - 1] ?? '';
  return segments.some((segment) => segment.startsWith('.')) || fileName.toLowerCase() === 'latexmkrc';
}

// Solo ASCII y sin metacaracteres de shell: latexmk interpola este nombre en comandos de /bin/sh (entre
// comillas dobles). Ningún segmento empieza con `-` (se tomaría como opción). Se admiten espacios simples
// dentro de un nombre (`Anexo 2.tex`), siempre seguidos de una letra, un dígito o `_`: nunca al
// principio, al final, dobles ni delante de `-` o `.`.
const MAIN_FILE_PATTERN = /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]| (?=[A-Za-z0-9_]))*\/)*[A-Za-z0-9_](?:[A-Za-z0-9._-]| (?=[A-Za-z0-9_]))*\.tex$/;

/** Valida el documento principal. Se usa en la API y otra vez en el worker antes de armar los argumentos. */
export function isValidMainFile(path: string): boolean {
  return (
    path.length <= MAX_PATH_LENGTH &&
    path.split('/').length <= MAX_PATH_DEPTH &&
    MAIN_FILE_PATTERN.test(path)
  );
}

const MAGIC_COMMENT = /^%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)\s*$/i;
const MAGIC_COMMENT_MAX_LINES = 50;

/**
 * Lee el comentario mágico `% !TEX program = <motor>` del encabezado del documento: solo
 * las primeras líneas que sean comentarios o estén en blanco (hasta 50). Devuelve `null` si
 * no hay uno con un motor soportado.
 */
export function detectEngineFromSource(source: string): Engine | null {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const lines = text.split(/\r\n|\n|\r/, MAGIC_COMMENT_MAX_LINES);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (!line.startsWith('%')) break;
    const value = MAGIC_COMMENT.exec(line)?.[1]?.toLowerCase();
    if (value !== undefined && (ENGINES as readonly string[]).includes(value)) return value as Engine;
  }

  return null;
}

// UUID v4 en minúsculas, tal como lo genera crypto.randomUUID().
const COMPILATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Valida un id de compilación antes de usarlo en rutas de disco o consultas a Redis. */
export function isCompilationId(value: string): boolean {
  return COMPILATION_ID.test(value);
}

/** Clave de comparación: NFC (por si llega NFD) y sin distinguir mayúsculas. */
function collisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function reject(reason: PathRejectReason): PathCheck {
  return { ok: false, reason };
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Id de la base (proyecto, archivo, usuario, enlace) antes de usarlo en una consulta. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Clave de unicidad de una ruta dentro de un proyecto: NFC y minúsculas (ver `findPathCollision`). */
export function pathKey(path: string): string {
  return collisionKey(path);
}
