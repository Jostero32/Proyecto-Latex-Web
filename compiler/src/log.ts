// Diagnósticos de una compilación: errores y avisos del log de LaTeX (compilado con -file-line-error
// y max_print_line alto, para que las rutas no se partan en varias líneas) y del .blg de biber o
// bibtex. Es una heurística, como la de cualquier editor de LaTeX: lo que no se reconoce se ignora.
import type { Diagnostic } from '@latexweb/shared';

/** Tope de diagnósticos por compilación y de largo de cada mensaje (viajan en el resultado del job). */
export const MAX_DIAGNOSTICS = 100;
const MAX_MESSAGE_LENGTH = 500;

const FILE_LINE_ERROR = /^(\.?\/?[^:\s][^:]*\.[A-Za-z]+):(\d+): (.*)$/;
const WARNING = /^(?:LaTeX|Package ([\w@*-]+)|Class ([\w@*-]+)) Warning: (.*)$/;
const BOX = /^((?:Overfull|Underfull) \\[hv]box .*?)(?: in paragraph at lines (\d+)--\d+| detected at line (\d+)|$)/;
const INPUT_LINE = /on input line (\d+)\.?/;
// Un `(` seguido de algo con forma de archivo abre ese archivo; el `)` correspondiente lo cierra.
const OPEN_FILE = /^\(([^\s()]+)/;

/** Ruta del proyecto a partir de la del log (relativa a /work), o null si es de TeX Live. */
export function projectPath(raw: string): string | null {
  let path = raw.replace(/^\/work\//, '');
  if (path.startsWith('/')) return null;
  while (path.startsWith('./')) path = path.slice(2);
  return path === '' || path.split('/').includes('..') ? null : path;
}

export function parseLatexLog(log: string): Diagnostic[] {
  const lines = log.split(/\r?\n/);
  const files: (string | null)[] = [];
  const current = () => {
    for (let i = files.length - 1; i >= 0; i--) if (files[i] !== null) return files[i] ?? null;
    return null;
  };
  const result: Diagnostic[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const error = FILE_LINE_ERROR.exec(line);
    if (error) {
      const message = (error[3] ?? '').replace(/^(?:LaTeX|Package \S+|Class \S+) Error: /, '');
      result.push({ file: projectPath(error[1] ?? ''), line: Number(error[2]), level: 'error', message });
      continue;
    }
    if (line.startsWith('! ')) {
      const message = line.slice(2).replace(/^(?:LaTeX|Package \S+|Class \S+) Error: /, '');
      // Consecuencias de un error anterior, no un error nuevo.
      if (!/^(?:Emergency stop|==> Fatal error occurred)/.test(message)) {
        const where = /^l\.(\d+) /.exec(lines.slice(i + 1, i + 10).find((l) => /^l\.\d+ /.test(l)) ?? '');
        result.push({ file: current(), line: where ? Number(where[1]) : null, level: 'error', message });
      }
      continue;
    }

    const warning = WARNING.exec(line);
    if (warning) {
      // Los avisos de paquetes siguen en las líneas que empiezan con `(paquete)`.
      const name = warning[1] ?? warning[2];
      let message = warning[3] ?? '';
      while (name && (lines[i + 1] ?? '').startsWith(`(${name})`)) {
        i++;
        message += ` ${(lines[i] ?? '').slice(name.length + 2).trim()}`;
      }
      const at = INPUT_LINE.exec(message);
      result.push({
        file: current(),
        line: at ? Number(at[1]) : null,
        level: 'warning',
        message: (name ? `${name}: ` : '') + message.replace(INPUT_LINE, '').replace(/\s+$/, '').replace(/\.$/, ''),
      });
      continue;
    }

    const box = BOX.exec(line);
    if (box) {
      const at = box[2] ?? box[3];
      result.push({ file: current(), line: at ? Number(at) : null, level: 'info', message: box[1] ?? line });
    }

    // Archivos que se abren y cierran en esta línea.
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '(') {
        const opened = OPEN_FILE.exec(line.slice(j));
        const path = opened?.[1];
        files.push(path && /\.[A-Za-z]+$/.test(path) ? projectPath(path) : null);
      } else if (char === ')') {
        files.pop();
      }
    }
  }
  return finish(result);
}

/** Avisos y errores del .blg: biber (`WARN - …`, `ERROR - …`) o bibtex (`Warning--…`, `---line N of file x`). */
export function parseBlg(blg: string): Diagnostic[] {
  const lines = blg.split(/\r?\n/);
  const result: Diagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const biber = /\b(ERROR|WARN) - (.*)$/.exec(line);
    if (biber) {
      const at = /\bline (\d+)\b/.exec(biber[2] ?? '');
      result.push({ file: null, line: at ? Number(at[1]) : null, level: biber[1] === 'ERROR' ? 'error' : 'warning', message: biber[2] ?? '' });
      continue;
    }
    if (line.startsWith('Warning--')) {
      result.push({ file: null, line: null, level: 'warning', message: line.slice('Warning--'.length) });
      continue;
    }
    const bibtex = /^(.*)---line (\d+) of file (.+)$/.exec(line);
    if (bibtex) {
      const message = bibtex[1] || lines[i - 1] || 'Error de BibTeX';
      result.push({ file: projectPath(bibtex[3] ?? ''), line: Number(bibtex[2]), level: 'error', message });
    }
  }
  return finish(result);
}

/** Sin repetidos (latexmk compila varias veces y repite avisos), con los topes, errores primero. */
export function finish(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const key = `${d.level}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const order = { error: 0, warning: 1, info: 2 } as const;
  return unique
    .sort((a, b) => order[a.level] - order[b.level])
    .slice(0, MAX_DIAGNOSTICS)
    .map((d) => ({ ...d, message: d.message.trim().slice(0, MAX_MESSAGE_LENGTH) }));
}
