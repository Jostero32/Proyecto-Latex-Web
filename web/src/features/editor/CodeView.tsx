// Vista del código del paso 1: LaTeX resaltado, números de línea, marcas de error, cursores remotos,
// minimapa y regla de errores. No se edita todavía: en el paso 3 la reemplaza CodeMirror 6 con
// y-codemirror.next, con este mismo aspecto (los colores salen de los mismos tokens).
import { useEffect, useRef } from 'react';
import { Icon } from '../../components/Icon';
import type { RemoteCursor } from '../../lib/mock';

const TOKEN = /(%.*$)|(\\[a-zA-Z@]+|\\.)|(\$[^$]*\$)|([{}[\]])|([^\\%${}[\]]+)|(.)/g;

interface Token {
  text: string;
  className: string;
}

function tokenize(line: string, underline: string | undefined): Token[] {
  const math = /^\s+[A-Z] = /.test(line);
  const tokens: Token[] = [];
  for (const match of line.matchAll(TOKEN)) {
    const [text, comment, command, inlineMath, brace] = match;
    let className = math ? 'text-math' : 'text-text';
    if (comment) className = 'text-faint italic';
    else if (command) className = 'text-accent';
    else if (inlineMath) className = 'text-math';
    else if (brace) className = 'text-faint';
    if (underline && text === underline) className += ' underline decoration-error decoration-wavy decoration-[1.5px] underline-offset-4';
    tokens.push({ text, className });
  }
  return tokens;
}

/** Ancho de las columnas a la izquierda del texto: marca (20) + número (40) + margen (12). */
const GUTTER = 72;
const LINE_HEIGHT = 22;

interface CodeViewProps {
  path: string;
  lines: string[];
  /** Línea → texto a subrayar (el comando del error). */
  errors: Map<number, string | undefined>;
  jumpLine: number | null;
  cursor: { line: number; column: number } | null;
  remoteCursors: RemoteCursor[];
  readOnly: boolean;
  minimap: boolean;
}

export function CodeView({ path, lines, errors, jumpLine, cursor, remoteCursors, readOnly, minimap }: CodeViewProps) {
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!jumpLine || !scroller.current) return;
    const top = (jumpLine - 1) * LINE_HEIGHT - scroller.current.clientHeight / 3;
    scroller.current.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [jumpLine, path]);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scroller}
        role="textbox"
        aria-multiline="true"
        aria-readonly={readOnly}
        aria-label={`Código de ${path}`}
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto pt-2 pb-8 font-mono text-[13px] leading-[22px]"
      >
        <div className="relative min-w-fit">
          {lines.map((line, index) => {
            const number = index + 1;
            const jump = number === jumpLine;
            const current = number === cursor?.line;
            return (
              <div
                key={number}
                className={`flex h-[22px] items-center pr-24 ${jump ? 'bg-jump shadow-[inset_0_1px_0_var(--c-accent),inset_0_-1px_0_var(--c-accent)]' : current ? 'bg-line' : ''}`}
              >
                <span className="flex w-5 flex-none justify-center">
                  {errors.has(number) && (
                    <span className="text-error" title="Error en esta línea">
                      <Icon name="error" size={14} strokeWidth={2} />
                    </span>
                  )}
                </span>
                <span className={`w-10 flex-none text-right text-xs select-none ${jump || current ? 'text-text' : 'text-faint'} ${jump ? 'font-semibold' : ''}`}>
                  {number}
                </span>
                <span className="pl-3 whitespace-pre">
                  {tokenize(line, errors.get(number)).map((token, i) => (
                    <span key={i} className={token.className}>
                      {token.text}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}

          {remoteCursors.map((remote) => {
            const top = (remote.line - 1) * LINE_HEIGHT;
            const above = remote.line > 1;
            return (
              <div key={remote.name} aria-hidden="true" className="pointer-events-none">
                {remote.selectionFrom !== undefined && (
                  <span
                    className="absolute h-[22px]"
                    style={{
                      top,
                      left: `calc(${GUTTER}px + ${remote.selectionFrom}ch)`,
                      width: `${remote.column - remote.selectionFrom}ch`,
                      background: `${remote.color}38`,
                    }}
                  />
                )}
                {/* La etiqueta va dentro de la barra: `ch` se mide con la fuente de cada elemento. */}
                <span className="absolute h-5 w-0.5" style={{ top: top + 1, left: `calc(${GUTTER}px + ${remote.column}ch)`, background: remote.color }}>
                  <span
                    className="absolute left-0 font-sans text-[11px] leading-4 font-semibold whitespace-nowrap text-white"
                    style={{
                      top: above ? -16 : 20,
                      background: remote.color,
                      padding: '0 6px',
                      borderRadius: above ? '4px 4px 4px 0' : '0 4px 4px 4px',
                    }}
                  >
                    {remote.name}
                  </span>
                </span>
              </div>
            );
          })}

          {cursor && !readOnly && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute h-5 w-0.5 animate-blink bg-text"
              style={{ top: (cursor.line - 1) * LINE_HEIGHT + 1, left: `calc(${GUTTER}px + ${cursor.column}ch)` }}
            />
          )}
        </div>
      </div>

      {minimap && (
        <div aria-hidden="true" className="flex w-[72px] flex-none flex-col gap-px overflow-hidden border-l border-border bg-surface px-1.5 py-2.5">
          {lines.map((line, index) => {
            const indent = line.length - line.trimStart().length;
            return (
              <span
                key={index}
                className={`h-0.5 flex-none rounded-[1px] ${errors.has(index + 1) ? 'bg-error' : 'bg-minimap'}`}
                style={{ width: Math.min(line.trim().length, 64) * 0.85, marginLeft: indent * 0.85 }}
              />
            );
          })}
        </div>
      )}

      <div aria-hidden="true" className="relative w-3 flex-none border-l border-border bg-bg">
        {[...errors.keys()].map((line) => (
          <span key={line} className="absolute right-0.5 left-0.5 h-1 rounded-[1px] bg-error" style={{ top: `${((line - 1) / lines.length) * 100}%` }} />
        ))}
      </div>
    </div>
  );
}
