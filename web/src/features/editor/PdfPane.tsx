// Panel del PDF: botón Compilar (lo único con el acento en el editor) con selector de motor, chip con el
// resultado, descargas, zoom, páginas y el PDF (PdfView). Clic en el PDF: ir al código (SyncTeX).
import { useCallback, useRef, useState } from 'react';
import type { Engine } from '@latexweb/shared';
import { IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Menu } from '../../components/Menu';
import { Notice, StatusChip } from '../../components/Notice';
import { formatSeconds, MOD_KEY } from '../../lib/format';
import type { CompilePhase, CompileResult } from './compile';
import { PdfView, PX_PER_PT, usePdfDocument, type PdfViewHandle } from './PdfView';
import { countLabel } from './ProblemsPanel';
import type { SyncRect } from './synctex';

export const ENGINE_LABELS: Record<Engine, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' };

interface PdfPaneProps {
  phase: CompilePhase;
  /** Segundos desde que arrancó (compilando) o que faltan para reintentar (cola llena). */
  seconds: number;
  result: CompileResult | null;
  /** El PDF que se muestra: el de la última compilación que dio uno. */
  pdfUrl: string | null;
  engine: Engine;
  canChangeEngine: boolean;
  highlight: { rects: SyncRect[]; key: number } | null;
  /** Hay SyncTeX del PDF que se muestra: el clic lleva al código. */
  canSync: boolean;
  /** Aviso corto sobre el PDF (p. ej. una línea que no aparece). */
  message: string | null;
  onCompile: () => void;
  onEngine: (engine: Engine) => void;
  onHide: () => void;
  onShowProblems: () => void;
  onShowLog: () => void;
  onDownload: () => void;
  onPoint: (page: number, x: number, y: number) => void;
}

const ZOOMS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300];
const MIN_ZOOM = 50;
const MAX_ZOOM = 300;
type Fit = 'width' | 'page' | null;

export function PdfPane(props: PdfPaneProps) {
  const { phase, result, pdfUrl, highlight, canSync, message, onHide, onShowProblems, onShowLog, onDownload, onPoint } = props;
  const pdf = usePdfDocument(pdfUrl);
  const view = useRef<PdfViewHandle>(null);
  const [zoom, setZoom] = useState(100);
  const [fit, setFit] = useState<Fit>('width');
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [page, setPage] = useState(1);
  const onViewport = useCallback((size: { width: number; height: number }) => setViewport(size), []);

  const loaded = pdf.loaded;
  const pages = loaded?.sizes.length ?? 0;
  const first = loaded?.sizes[0];
  // Ajustar usa la primera página; el zoom elegido, el tamaño real (100 % = 1 pt del PDF a 96 ppp).
  let fitted: number | null = null;
  if (first && viewport.width > 0 && fit) {
    fitted = fit === 'width' ? viewport.width / first.width : Math.min(viewport.width / first.width, viewport.height / first.height);
  }
  const scale = Math.max(0.2, fitted ?? (zoom / 100) * PX_PER_PT);
  const percent = Math.round((scale / PX_PER_PT) * 100);
  const changeZoom = (step: 1 | -1) => {
    const next = step > 0 ? ZOOMS.find((z) => z > percent) : [...ZOOMS].reverse().find((z) => z < percent);
    if (next) setZoom(next);
    setFit(null);
  };

  const busy = phase !== 'idle';
  // La última no dio PDF: si hay uno anterior, queda atenuado debajo del aviso.
  const failedNow =
    !busy &&
    result !== null &&
    (result.status === 'timeout' || result.status === 'failed' || result.pdfTooLarge || (result.status === 'error' && !result.hasPdf));
  const shown = loaded !== null;
  const currentPage = Math.min(page, Math.max(pages, 1));

  return (
    <section aria-label="PDF" className="@container flex h-full min-h-0 flex-col bg-pdf-bg">
      <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-border bg-surface pr-2 pl-3">
        <CompileButton {...props} />
        {/* El chip cede espacio: los botones de la derecha siempre se ven. */}
        <span className="flex min-w-0 flex-1 overflow-hidden">
          <ResultChip phase={phase} seconds={props.seconds} result={result} />
        </span>
        <IconButton icon="download" size="sm" label="Descargar PDF" disabled={!pdfUrl} onClick={onDownload} />
        <IconButton icon="log" size="sm" label="Ver log completo" onClick={onShowLog} />
        <IconButton icon="panelRight" size="sm" label="Ocultar PDF" onClick={onHide} />
      </div>

      <div role="toolbar" aria-label="Vista del PDF" className="flex h-10 flex-none items-center gap-0.5 border-b border-border bg-bg px-2 text-[13px] text-muted">
        <IconButton
          icon="chevLeft"
          size="xs"
          label="Página anterior"
          disabled={!shown || currentPage <= 1}
          onClick={() => view.current?.scrollToPage(currentPage - 1)}
        />
        <span className="min-w-11 text-center font-mono text-xs text-text">{shown ? `${currentPage} / ${pages}` : '– / –'}</span>
        <IconButton
          icon="chevRight"
          size="xs"
          label="Página siguiente"
          disabled={!shown || currentPage >= pages}
          onClick={() => view.current?.scrollToPage(currentPage + 1)}
        />
        <span aria-hidden="true" className="mx-1.5 h-[18px] w-px bg-border" />
        <IconButton icon="zoomOut" size="xs" label="Alejar" onClick={() => changeZoom(-1)} disabled={!shown || percent <= MIN_ZOOM} />
        <span className="min-w-11 text-center font-mono text-xs text-text">{shown ? `${percent} %` : '– %'}</span>
        <IconButton icon="zoomIn" size="xs" label="Acercar" onClick={() => changeZoom(1)} disabled={!shown || percent >= MAX_ZOOM} />
        <span aria-hidden="true" className="mx-1.5 h-[18px] w-px bg-border" />
        <FitButton icon="fitWidth" on={fit === 'width'} onClick={() => setFit('width')}>
          Ancho
        </FitButton>
        <FitButton icon="fitPage" on={fit === 'page'} onClick={() => setFit('page')}>
          Página
        </FitButton>
      </div>

      <div className="relative min-h-0 flex-1" title={shown && canSync ? 'Clic en el PDF para ir a esa línea del código' : undefined}>
        {loaded ? (
          <PdfView
            ref={view}
            pdf={loaded}
            scale={scale}
            maxWidth={fitted !== null ? viewport.width : null}
            dimmed={failedNow}
            highlight={highlight}
            clickable={canSync}
            onViewport={onViewport}
            onPage={setPage}
            onPoint={onPoint}
          />
        ) : pdf.error ? (
          !failedNow && (
            <div className="m-3.5">
              <Notice tone="error" title="No se pudo mostrar el PDF">
                {pdf.error}
              </Notice>
            </div>
          )
        ) : pdfUrl ? (
          <div aria-busy="true" className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted">
            <Icon name="spinner" size={16} className="animate-spin" />
            Abriendo el PDF…
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
          <div className={`${shown ? 'absolute top-3.5 right-3.5 left-3.5' : 'm-3.5'} z-10 rounded-[10px] border border-border bg-surface shadow-pop`}>
            <FailureNotice result={result} hasPdf={shown} onShowProblems={onShowProblems} onShowLog={onShowLog} />
          </div>
        )}

        {message && (
          <p role="status" className="absolute bottom-4 left-1/2 z-10 m-0 max-w-[90%] -translate-x-1/2 rounded-lg bg-text px-3 py-2 text-center text-[13px] text-bg shadow-pop">
            {message}
          </p>
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
  if (result.status === 'error') {
    return <StatusChip tone="error">{result.errorCount > 0 ? countLabel('error', result.errorCount) : 'Sin PDF'} · {time}</StatusChip>;
  }
  if (result.status === 'timeout') return <StatusChip tone="warning" icon="clock">Tiempo agotado · {time}</StatusChip>;
  return <StatusChip tone="error" icon="cloudOff">No pudimos compilar</StatusChip>;
}

function FailureNotice({ result, hasPdf, onShowProblems, onShowLog }: { result: CompileResult; hasPdf: boolean; onShowProblems: () => void; onShowLog: () => void }) {
  const previous = hasPdf ? ' Abajo queda el último PDF que salió bien.' : '';
  const actions = (
    <>
      {result.status !== 'failed' && result.errorCount > 0 && (
        <button type="button" onClick={onShowProblems} className="h-8 rounded-md bg-surface-2 px-3 text-[13px] font-semibold text-text hover:brightness-95">
          Ver problemas
        </button>
      )}
      {result.status !== 'failed' && (
        <button type="button" onClick={onShowLog} className="h-8 rounded-md px-2.5 text-[13px] font-medium text-accent-text hover:bg-surface-2">
          Ver log
        </button>
      )}
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
      <Notice tone="error" icon="cloudOff" title="No pudimos compilar" className="bg-transparent">
        {result.message ?? 'No es un problema de tu documento: el servicio de compilación falló. Reintentá en un momento.'}
        {previous}
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
  if (result.errorCount === 0) {
    return (
      <Notice tone="error" title="No se generó el PDF" actions={actions} className="bg-transparent">
        La compilación terminó sin PDF y sin un error que podamos señalar. El log dice qué pasó.{previous}
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
