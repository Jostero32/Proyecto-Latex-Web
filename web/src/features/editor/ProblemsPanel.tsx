// Panel de problemas de la última compilación. Plegado: una barra con los contadores por nivel y la
// posición del cursor. Abierto: filtros y la lista; cada ítem muestra el mensaje original del log (como
// texto), la pista en español y la ubicación, y al hacer clic salta a la línea.
import { useState, type ReactNode } from 'react';
import type { Diagnostic, DiagnosticLevel } from '@latexweb/shared';
import { Icon, type IconName } from '../../components/Icon';
import { hintFor } from '../../lib/hints';

const LEVELS: Record<DiagnosticLevel, { icon: IconName; text: string; soft: string; one: string; many: string }> = {
  error: { icon: 'error', text: 'text-error', soft: 'bg-error-soft', one: 'error', many: 'errores' },
  warning: { icon: 'warning', text: 'text-warning', soft: 'bg-warning-soft', one: 'advertencia', many: 'advertencias' },
  info: { icon: 'info', text: 'text-accent-text', soft: 'bg-accent-soft', one: 'mensaje', many: 'mensajes' },
};
const ORDER: DiagnosticLevel[] = ['error', 'warning', 'info'];

export const countLabel = (level: DiagnosticLevel, count: number) => `${count} ${count === 1 ? LEVELS[level].one : LEVELS[level].many}`;

interface ProblemsPanelProps {
  diagnostics: Diagnostic[] | null;
  open: boolean;
  onToggle: () => void;
  selected: number | null;
  onSelect: (index: number, diagnostic: Diagnostic) => void;
  cursor: { line: number; column: number } | null;
  onShowLog: () => void;
}

export function ProblemsPanel({ diagnostics, open, onToggle, selected, onSelect, cursor, onShowLog }: ProblemsPanelProps) {
  const [filter, setFilter] = useState<DiagnosticLevel | 'all'>('all');
  const list = diagnostics ?? [];
  const counts = Object.fromEntries(ORDER.map((level) => [level, list.filter((d) => d.level === level).length])) as Record<DiagnosticLevel, number>;
  const empty = diagnostics === null ? 'Todavía no compilaste este proyecto.' : 'Sin problemas en la última compilación.';

  if (!open) {
    return (
      <div className="flex h-9 flex-none items-center gap-1 border-t border-border bg-bg pr-3 pl-1.5">
        <button type="button" aria-expanded="false" onClick={onToggle} className="flex h-7 items-center gap-2 rounded-md px-2 text-[13px] hover:bg-surface-2">
          <Icon name="chevUp" size={14} />
          <span className="font-semibold">Problemas</span>
          {list.length === 0 ? (
            <span className="flex items-center gap-1 text-muted">
              <Icon name="check" size={14} className="text-success" />
              {empty}
            </span>
          ) : (
            ORDER.filter((level) => counts[level] > 0).map((level) => (
              <span key={level} className={`inline-flex h-[22px] items-center gap-1 rounded px-1.5 text-[12.5px] font-semibold ${LEVELS[level].soft} ${LEVELS[level].text}`}>
                <Icon name={LEVELS[level].icon} size={13} strokeWidth={2} />
                {counts[level]}
                <span className="sr-only"> {counts[level] === 1 ? LEVELS[level].one : LEVELS[level].many}</span>
              </span>
            ))
          )}
        </button>
        <span className="flex-1" />
        {cursor && (
          <span className="font-mono text-xs text-muted">
            Lín. {cursor.line}, col. {cursor.column + 1}
          </span>
        )}
      </div>
    );
  }

  const visible = list.map((diagnostic, index) => ({ diagnostic, index })).filter(({ diagnostic }) => filter === 'all' || diagnostic.level === filter);

  return (
    <section aria-label="Problemas de la última compilación" className="flex h-[248px] flex-none flex-col border-t border-border bg-bg">
      <div className="flex h-[42px] flex-none items-center gap-1 border-b border-border pr-2 pl-1.5">
        <button type="button" aria-expanded="true" onClick={onToggle} className="flex h-[30px] items-center gap-1.5 rounded-md px-2 text-[13px] font-semibold hover:bg-surface-2">
          <Icon name="chevDown" size={14} />
          Problemas
        </button>
        <div className="ml-1.5 flex gap-0.5 overflow-x-auto">
          <FilterButton on={filter === 'all'} onClick={() => setFilter('all')}>
            Todos {list.length}
          </FilterButton>
          {ORDER.map((level) => (
            <FilterButton key={level} on={filter === level} onClick={() => setFilter(level)}>
              <Icon name={LEVELS[level].icon} size={13} className={LEVELS[level].text} />
              {level === 'info' ? `${counts.info} info` : countLabel(level, counts[level])}
            </FilterButton>
          ))}
        </div>
        <span className="flex-1" />
        <button type="button" onClick={onShowLog} className="flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-accent-text hover:bg-surface-2">
          <Icon name="log" size={15} />
          Ver log completo
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 py-1">
        {visible.length === 0 && (
          <p className="mx-2.5 my-4 flex items-center gap-2 text-[13.5px] text-muted">
            <Icon name="check" size={16} className="text-success" />
            {list.length === 0 ? empty : 'Nada con este filtro.'}
          </p>
        )}
        <ul className="m-0 list-none p-0">
          {visible.map(({ diagnostic, index }) => (
            <li key={index}>
              <ProblemItem diagnostic={diagnostic} selected={selected === index} onClick={() => onSelect(index, diagnostic)} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FilterButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] whitespace-nowrap ${on ? 'bg-surface-2 font-semibold text-text' : 'font-medium text-muted hover:text-text'}`}
    >
      {children}
    </button>
  );
}

function ProblemItem({ diagnostic, selected, onClick }: { diagnostic: Diagnostic; selected: boolean; onClick: () => void }) {
  const level = LEVELS[diagnostic.level];
  const hint = hintFor(diagnostic.message);
  const slash = diagnostic.file?.lastIndexOf('/') ?? -1;
  const dir = diagnostic.file && slash >= 0 ? diagnostic.file.slice(0, slash + 1) : '';
  const base = diagnostic.file ? diagnostic.file.slice(slash + 1) : '';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      className={`grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg px-2.5 py-[9px] text-left ${
        selected ? 'bg-surface shadow-[inset_0_0_0_1px_var(--c-border)]' : 'hover:bg-surface/60'
      }`}
    >
      <span className={`mt-px ${level.text}`}>
        <Icon name={level.icon} size={16} strokeWidth={2} />
        <span className="sr-only">{diagnostic.level === 'error' ? 'Error' : diagnostic.level === 'warning' ? 'Advertencia' : 'Información'}: </span>
      </span>
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="truncate font-mono text-[12.5px] text-text" title={diagnostic.message}>
          {diagnostic.message}
        </span>
        {hint && (
          <span className="flex items-start gap-1.5 text-[13px] leading-snug text-muted">
            <Icon name="bulb" size={14} className="mt-0.5" />
            <span>{hint}</span>
          </span>
        )}
      </span>
      {diagnostic.file ? (
        <span
          title={`${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ''}`}
          className="flex h-6 max-w-[230px] min-w-0 items-center rounded bg-surface-2 px-2 font-mono text-xs"
        >
          {/* La ruta se corta por el principio: el archivo y la línea siempre se ven. */}
          <span className="min-w-0 truncate text-muted [direction:rtl]">
            {/* Marcas LTR: sin ellas, la dirección rtl movería la barra final al principio. */}
            {`‎${dir}‎`}
          </span>
          <span className="flex-none whitespace-nowrap">
            {base}
            {diagnostic.line ? `:${diagnostic.line}` : ''}
          </span>
        </span>
      ) : (
        <span className="flex h-6 items-center text-[12.5px] whitespace-nowrap text-muted">Sin archivo ni línea · ver log</span>
      )}
    </button>
  );
}
