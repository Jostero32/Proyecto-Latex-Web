// Panel del PDF: botón Compilar (lo único con el acento en el editor) con selector de motor, chip con el
// resultado, descargas, zoom y la página. Paso 1: la página es una muestra; en el paso 4 la dibuja PDF.js
// y el clic usa SyncTeX.
import { useState } from 'react';
import type { Engine } from '@latexweb/shared';
import { IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Menu } from '../../components/Menu';
import { Notice, StatusChip } from '../../components/Notice';
import { formatSeconds, MOD_KEY } from '../../lib/format';
import { countLabel } from './ProblemsPanel';

export const ENGINE_LABELS: Record<Engine, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' };

export type CompilePhase = 'idle' | 'queued' | 'running' | 'busy';

export interface CompileResult {
  status: 'success' | 'error' | 'timeout' | 'failed';
  durationMs: number;
  errorCount: number;
  /** El PDF se generó pero superaba el tamaño máximo. */
  pdfTooLarge?: boolean;
}

interface PdfPaneProps {
  phase: CompilePhase;
  /** Segundos desde que arrancó (compilando) o que faltan para reintentar (cola llena). */
  seconds: number;
  result: CompileResult | null;
  /** Hay un PDF bueno de antes: se muestra atenuado si la última falló. */
  hasPdf: boolean;
  engine: Engine;
  canChangeEngine: boolean;
  syncLine: number | null;
  onCompile: () => void;
  onEngine: (engine: Engine) => void;
  onHide: () => void;
  onShowProblems: () => void;
  onShowLog: () => void;
  onJumpToLine: (line: number) => void;
}

const ZOOMS = [50, 67, 75, 92, 100, 125, 150, 200];

export function PdfPane(props: PdfPaneProps) {
  const { phase, result, hasPdf, syncLine, onHide, onShowProblems, onShowLog, onJumpToLine } = props;
  const [zoom, setZoom] = useState(92);
  const [fit, setFit] = useState<'width' | 'page' | null>('width');
  const busy = phase !== 'idle';
  const failedNow = !busy && result !== null && (result.status !== 'success' || result.pdfTooLarge === true);
  const zoomIndex = ZOOMS.indexOf(zoom);
  const changeZoom = (step: number) => {
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, zoomIndex + step))];
    if (next) setZoom(next);
    setFit(null);
  };

  return (
    <section aria-label="PDF" className="@container flex h-full min-h-0 flex-col bg-pdf-bg">
      <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-border bg-surface pr-2 pl-3">
        <CompileButton {...props} />
        {/* El chip cede espacio: los botones de la derecha siempre se ven. */}
        <span className="flex min-w-0 flex-1 overflow-hidden">
          <ResultChip phase={phase} seconds={props.seconds} result={result} />
        </span>
        <IconButton icon="download" size="sm" label="Descargar PDF" disabled={!hasPdf} />
        <IconButton icon="log" size="sm" label="Ver log completo" onClick={onShowLog} />
        <IconButton icon="panelRight" size="sm" label="Ocultar PDF" onClick={onHide} />
      </div>

      <div role="toolbar" aria-label="Vista del PDF" className="flex h-10 flex-none items-center gap-0.5 border-b border-border bg-bg px-2 text-[13px] text-muted">
        <IconButton icon="chevLeft" size="xs" label="Página anterior" disabled />
        <span className="min-w-11 text-center font-mono text-xs text-text">1 / 2</span>
        <IconButton icon="chevRight" size="xs" label="Página siguiente" />
        <span aria-hidden="true" className="mx-1.5 h-[18px] w-px bg-border" />
        <IconButton icon="zoomOut" size="xs" label="Alejar" onClick={() => changeZoom(-1)} disabled={zoomIndex === 0} />
        <span className="min-w-11 text-center font-mono text-xs text-text">{zoom} %</span>
        <IconButton icon="zoomIn" size="xs" label="Acercar" onClick={() => changeZoom(1)} disabled={zoomIndex === ZOOMS.length - 1} />
        <span aria-hidden="true" className="mx-1.5 h-[18px] w-px bg-border" />
        <FitButton icon="fitWidth" on={fit === 'width'} onClick={() => setFit('width')}>
          Ancho
        </FitButton>
        <FitButton icon="fitPage" on={fit === 'page'} onClick={() => setFit('page')}>
          Página
        </FitButton>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {hasPdf ? (
          <div
            className={`flex flex-col items-center gap-4 px-4 py-6 transition-opacity ${failedNow ? 'opacity-[0.42]' : ''}`}
            style={{ zoom: zoom / 92 }}
            title="Clic en el PDF para ir a esa línea del código"
          >
            <SamplePage syncLine={syncLine} onJumpToLine={onJumpToLine} />
            <div className="h-[120px] w-[440px] flex-none bg-white px-[50px] pt-[50px] font-paper text-[#1b1a17] shadow-[0_1px_3px_rgb(0_0_0/0.14)]">
              <p className="m-0 text-xs font-semibold">2&nbsp;&nbsp;&nbsp;Métodos</p>
            </div>
          </div>
        ) : (
          !failedNow && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-10 text-center">
              <div aria-hidden="true" className="flex h-32 w-24 items-center justify-center rounded border-[1.5px] border-dashed border-border-input text-muted">
                <Icon name="pdf" size={28} strokeWidth={1.5} />
              </div>
              <strong className="text-base font-semibold">Todavía no hay PDF</strong>
              <span className="max-w-[300px] text-sm leading-normal text-muted">Tocá Compilar o usá {MOD_KEY}+S, y el documento aparece acá.</span>
            </div>
          )
        )}

        {failedNow && result && (
          <div className={`${hasPdf ? 'absolute top-3.5 right-3.5 left-3.5' : 'm-3.5'} z-10 rounded-[10px] border border-border bg-surface shadow-pop`}>
            <FailureNotice result={result} hasPdf={hasPdf} onShowProblems={onShowProblems} onShowLog={onShowLog} />
          </div>
        )}
      </div>
    </section>
  );
}

function CompileButton({ phase, seconds, engine, canChangeEngine, onCompile, onEngine }: PdfPaneProps) {
  const busy = phase !== 'idle';
  const label = phase === 'queued' ? 'En cola…' : phase === 'running' ? 'Compilando…' : phase === 'busy' ? `Reintentá en ${seconds} s` : 'Compilar';
  const icon = phase === 'queued' ? 'hourglass' : phase === 'running' ? 'spinner' : phase === 'busy' ? 'clock' : 'play';
  return (
    <div className={`flex h-9 flex-none rounded-md ${busy ? 'bg-accent-soft text-accent-text' : 'bg-accent text-on-accent'}`}>
      <button
        type="button"
        onClick={onCompile}
        disabled={busy}
        aria-busy={phase === 'queued' || phase === 'running'}
        className="flex items-center gap-2 rounded-l-md pr-2.5 pl-3 text-sm font-semibold disabled:cursor-not-allowed"
      >
        <Icon name={icon} size={16} filled={icon === 'play'} className={phase === 'running' ? 'animate-spin' : ''} />
        {label}
        {!busy && <kbd className="hidden rounded bg-white/20 px-1.5 whitespace-nowrap @lg:inline font-mono text-[11px] font-medium dark:bg-black/15">{MOD_KEY} S</kbd>}
      </button>
      <Menu
        align="left"
        width={260}
        heading="Motor de compilación"
        items={(Object.keys(ENGINE_LABELS) as Engine[]).map((value) => ({
          label: ENGINE_LABELS[value],
          checked: value === engine,
          onSelect: () => onEngine(value),
        }))}
        trigger={(props) => (
          <button
            type="button"
            disabled={!canChangeEngine || busy}
            aria-label={canChangeEngine ? `Motor: ${ENGINE_LABELS[engine]}. Cambiar motor` : `Motor: ${ENGINE_LABELS[engine]}`}
            title={canChangeEngine ? 'Cambiar motor' : 'Solo editores y dueños cambian el motor'}
            className="flex h-full items-center gap-1 rounded-r-md border-l border-current/25 pr-2 pl-2.5 text-[12.5px] font-semibold disabled:cursor-default"
            {...props}
          >
            {ENGINE_LABELS[engine]}
            {canChangeEngine ? <Icon name="chevDown" size={14} /> : <Icon name="lock" size={13} />}
          </button>
        )}
      />
    </div>
  );
}

function ResultChip({ phase, seconds, result }: { phase: CompilePhase; seconds: number; result: CompileResult | null }) {
  if (phase === 'running') return <StatusChip tone="neutral" icon="clock">{seconds} s</StatusChip>;
  if (phase === 'busy') return <StatusChip tone="warning" icon="hourglass">Mucha demanda ahora</StatusChip>;
  if (phase !== 'idle' || !result) return null;
  const time = formatSeconds(result.durationMs);
  if (result.pdfTooLarge) return <StatusChip tone="warning">PDF demasiado grande · {time}</StatusChip>;
  if (result.status === 'success') return <StatusChip tone="success">Listo · {time}</StatusChip>;
  if (result.status === 'error') return <StatusChip tone="error">{countLabel('error', result.errorCount)} · {time}</StatusChip>;
  if (result.status === 'timeout') return <StatusChip tone="warning" icon="clock">Tiempo agotado · {time}</StatusChip>;
  return <StatusChip tone="error" icon="cloudOff">No pudimos compilar</StatusChip>;
}

function FailureNotice({ result, hasPdf, onShowProblems, onShowLog }: { result: CompileResult; hasPdf: boolean; onShowProblems: () => void; onShowLog: () => void }) {
  const previous = hasPdf ? ' Abajo queda el último PDF que salió bien.' : '';
  const actions = (
    <>
      {result.status !== 'failed' && (
        <button type="button" onClick={onShowProblems} className="h-8 rounded-md bg-surface-2 px-3 text-[13px] font-semibold text-text hover:brightness-95">
          Ver problemas
        </button>
      )}
      <button type="button" onClick={onShowLog} className="h-8 rounded-md px-2.5 text-[13px] font-medium text-accent-text hover:bg-surface-2">
        Ver log
      </button>
    </>
  );
  if (result.status === 'timeout') {
    return (
      <Notice tone="warning" icon="clock" title="La compilación tardó demasiado" actions={actions} className="bg-transparent">
        La cortamos a los {formatSeconds(result.durationMs)}. Suele pasar con un bucle en una macro o con imágenes muy pesadas.{previous}
      </Notice>
    );
  }
  if (result.status === 'failed') {
    return (
      <Notice tone="error" icon="cloudOff" title="No pudimos compilar" actions={actions} className="bg-transparent">
        No es un problema de tu documento: el servicio de compilación falló. Reintentá en un momento.{previous}
      </Notice>
    );
  }
  if (result.pdfTooLarge) {
    return (
      <Notice tone="warning" title="El PDF es demasiado grande" actions={actions} className="bg-transparent">
        Se generó, pero supera el tamaño máximo. Probá achicar las imágenes.{previous}
      </Notice>
    );
  }
  return (
    <Notice tone="error" title={`No se generó el PDF: hubo ${countLabel('error', result.errorCount)}`} actions={actions} className="bg-transparent">
      Corregí el primero de la lista y volvé a compilar.{previous}
    </Notice>
  );
}

function FitButton({ icon, on, onClick, children }: { icon: 'fitWidth' | 'fitPage'; on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] ${on ? 'bg-accent-soft font-semibold text-accent-text' : 'font-medium text-muted hover:text-text'}`}
    >
      <Icon name={icon} size={14} />
      {children}
    </button>
  );
}

/** Página de muestra. Cada bloque sabe su línea del código: el clic salta ahí (SyncTeX simulado). */
function SamplePage({ syncLine, onJumpToLine }: { syncLine: number | null; onJumpToLine: (line: number) => void }) {
  const block = (line: number, className: string) =>
    `${className} cursor-pointer rounded-sm ${syncLine === line ? 'bg-[#2f45c6]/15 outline-2 outline-offset-2 outline-[#2f45c6]/40' : 'hover:bg-[#2f45c6]/[0.06]'}`;
  const jump = (line: number) => () => onJumpToLine(line);
  return (
    <div className="flex h-[622px] w-[440px] flex-none flex-col bg-white px-[50px] pt-[50px] pb-[30px] font-paper text-[#1b1a17] shadow-[0_1px_3px_rgb(0_0_0/0.14),0_8px_24px_rgb(0_0_0/0.10)]">
      <p onClick={jump(9)} className={block(9, 'm-0 text-center text-base')}>
        Erosión del suelo en laderas andinas
      </p>
      <p onClick={jump(10)} className={block(10, 'm-0 mt-2.5 flex justify-center gap-[22px] text-[10.5px]')}>
        <span>Ana Torres</span>
        <span>Lucía Paredes</span>
        <span>Mateo Ríos</span>
      </p>
      <p className="m-0 mt-1.5 text-center text-[10.5px]">17 de noviembre de 2026</p>
      <p className="m-0 mt-4 mb-1 text-center text-[9.5px] font-semibold">Resumen</p>
      <p onClick={jump(17)} className={block(17, 'mx-[26px] my-0 text-justify text-[9.5px] leading-[1.45]')}>
        Estimamos la pérdida de suelo en tres microcuencas con la ecuación universal revisada (RUSLE).
      </p>
      <p onClick={jump(21)} className={block(21, 'm-0 mt-4 mb-1.5 text-xs font-semibold')}>
        1&nbsp;&nbsp;&nbsp;Introducción
      </p>
      <p onClick={jump(22)} className={block(22, 'm-0 text-justify text-[10px] leading-normal')}>
        La erosión hídrica depende de la lluvia, el suelo, la pendiente y la cobertura [3]. La pérdida anual se estima como
      </p>
      <p onClick={jump(26)} className={block(26, 'mx-0 my-2 flex text-[11px]')}>
        <span className="flex-1 text-center">
          <i>A</i> = <i>R</i> · <i>K</i> · <i>LS</i> · <i>C</i> · <i>P</i>
        </span>
        <span>(1)</span>
      </p>
      <p onClick={jump(28)} className={block(28, 'm-0 text-justify text-[10px] leading-normal')}>
        donde <i>A</i> está en t/ha por año. Ver la Tabla 1.
      </p>
      <p onClick={jump(30)} className={block(30, 'm-0 indent-3.5 text-justify text-[10px] leading-normal')}>
        Las laderas andinas combinan pendientes fuertes con lluvias intensas concentradas en pocos meses, y la pérdida de suelo se acelera cuando
        se retira la cobertura nativa.
      </p>
      <div onClick={jump(34)} className={block(34, 'mx-auto mt-3.5 flex flex-col items-center gap-1.5')}>
        <svg width="200" height="90" viewBox="0 0 150 70" aria-hidden="true">
          <path d="M8 60 Q40 15 75 38 T142 12" fill="none" stroke="#2F45C6" strokeWidth="1.6" />
          <path d="M8 60 Q50 40 80 48 T142 40" fill="none" stroke="#0F766E" strokeWidth="1.6" strokeDasharray="4 3" />
          <path d="M8 64h134M8 6v58" stroke="#8F8B82" strokeWidth="0.8" />
        </svg>
        <p className="m-0 text-[9.5px]">Figura 1: Microcuencas estudiadas.</p>
      </div>
      <span className="flex-1" />
      <p className="m-0 text-center text-[9.5px]">1</p>
    </div>
  );
}
