// El PDF con PDF.js: cada página es un canvas que se dibuja solo cuando está cerca de la vista (y se
// libera al alejarse). Al cambiar el zoom o llegar un PDF nuevo, la página vieja queda hasta que la nueva
// está lista, sin parpadeo. PDF.js se baja recién cuando hay un PDF para mostrar.
//
// El PDF sale del documento del usuario: no se ejecuta su JavaScript (la librería sola no lo hace; el
// scripting es del visor completo, que no usamos) ni se dibujan formularios XFA.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { errorMessage, fetchApi, isApiError } from '../../lib/api';
import type { SyncRect } from './synctex';

/** Tamaño de una página en puntos del PDF. */
export interface PageSize {
  width: number;
  height: number;
}

export interface LoadedPdf {
  url: string;
  doc: PDFDocumentProxy;
  sizes: PageSize[];
}

/** Píxeles CSS por punto del PDF: zoom 100 % es el tamaño real. */
export const PX_PER_PT = 96 / 72;
/** Separación entre páginas y margen alrededor, en píxeles. */
const GAP = 16;
/** Un canvas más grande que esto (en píxeles) se dibuja con menos resolución. */
const MAX_CANVAS_PIXELS = 16_000_000;

let pdfjs: Promise<typeof import('pdfjs-dist')> | null = null;
function loadPdfjs() {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

/**
 * Baja y abre el PDF de `url`. Mientras llega uno nuevo sigue el anterior; el anterior se libera cuando
 * el nuevo ya se muestra.
 */
export function usePdfDocument(url: string | null) {
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  // La tarea de carga es la que libera el documento (y el worker).
  const current = useRef<PDFDocumentLoadingTask | null>(null);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    void (async () => {
      setLoading(url);
      try {
        const response = await fetchApi(url, controller.signal);
        const data = await response.arrayBuffer();
        const lib = await loadPdfjs();
        const task = lib.getDocument({ data, enableXfa: false });
        const doc = await task.promise;
        if (controller.signal.aborted) return void task.destroy();
        const sizes = await Promise.all(
          Array.from({ length: doc.numPages }, async (_, index) => {
            const viewport = (await doc.getPage(index + 1)).getViewport({ scale: 1 });
            return { width: viewport.width, height: viewport.height };
          }),
        );
        if (controller.signal.aborted) return void task.destroy();
        const previous = current.current;
        current.current = task;
        setLoaded({ url, doc, sizes });
        setError(null);
        // Las páginas viejas se desmontan con este render; recién ahí se libera el documento.
        if (previous) setTimeout(() => void previous.destroy(), 0);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(
          isApiError(cause, 'expired')
            ? 'El PDF venció: volvé a compilar para verlo.'
            : isApiError(cause)
              ? errorMessage(cause)
              : 'No pudimos abrir el PDF.',
        );
      } finally {
        if (!controller.signal.aborted) setLoading(null);
      }
    })();
    return () => controller.abort();
  }, [url]);

  useEffect(
    () => () => {
      void current.current?.destroy();
      current.current = null;
    },
    [],
  );

  return { loaded, error, loading: loading !== null };
}

export interface PdfViewHandle {
  scrollToPage: (page: number) => void;
}

interface PdfViewProps {
  ref?: Ref<PdfViewHandle>;
  pdf: LoadedPdf;
  /** Píxeles CSS por punto del PDF. */
  scale: number;
  dimmed: boolean;
  /** Bloques marcados por SyncTeX; `key` cambia en cada búsqueda (para volver a llevarlos a la vista). */
  highlight: { rects: SyncRect[]; key: number } | null;
  /** Se puede hacer clic para ir al código. */
  clickable: boolean;
  onViewport: (size: { width: number; height: number }) => void;
  onPage: (page: number) => void;
  onPoint: (page: number, x: number, y: number) => void;
}

export function PdfView({ ref, pdf, scale, dimmed, highlight, clickable, onViewport, onPage, onPoint }: PdfViewProps) {
  const pages = useRef<(HTMLDivElement | null)[]>([]);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const lastPage = useRef(0);

  useImperativeHandle(ref, () => ({
    scrollToPage: (page) => pages.current[page - 1]?.scrollIntoView({ block: 'start' }),
  }));

  // El tamaño disponible, para ajustar al ancho o a la página.
  useEffect(() => {
    const element = root;
    if (!element) return;
    const observer = new ResizeObserver(() => onViewport({ width: element.clientWidth - 2 * GAP, height: element.clientHeight - 2 * GAP }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [root, onViewport]);

  // Dónde está la vista: la página de arriba y cuánto de ella ya pasó. Al cambiar el zoom se vuelve ahí.
  const anchor = useRef({ index: 0, fraction: 0 });

  // La página actual: la última cuyo borde de arriba pasó el primer tercio de la vista.
  const updatePage = () => {
    const element = root;
    if (!element) return;
    const mark = element.scrollTop + element.clientHeight / 3;
    let page = 1;
    let top = 0;
    pages.current.forEach((node, index) => {
      if (node && node.offsetTop <= mark) page = index + 1;
      if (node && node.offsetTop <= element.scrollTop) top = index;
    });
    const topNode = pages.current[top];
    if (topNode) anchor.current = { index: top, fraction: (element.scrollTop - topNode.offsetTop) / topNode.offsetHeight };
    if (page !== lastPage.current) {
      lastPage.current = page;
      onPage(page);
    }
  };
  useEffect(updatePage);

  useLayoutEffect(() => {
    const node = pages.current[anchor.current.index];
    root?.scrollTo({ top: node ? node.offsetTop + anchor.current.fraction * node.offsetHeight : 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  // Lo marcado por SyncTeX se lleva a la vista (a un tercio de la altura).
  useEffect(() => {
    const first = highlight?.rects[0];
    const element = root;
    const page = first ? pages.current[first.page - 1] : null;
    if (!first || !element || !page) return;
    element.scrollTo({ top: page.offsetTop + first.y * scale - element.clientHeight / 3, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.key]);

  return (
    <div
      ref={setRoot}
      onScroll={updatePage}
      className="absolute inset-0 overflow-auto"
    >
      <div className={`flex w-max min-w-full flex-col items-center transition-opacity ${dimmed ? 'opacity-[0.42]' : ''}`} style={{ gap: GAP, padding: GAP }}>
        {pdf.sizes.map((size, index) => (
          <PdfPage
            key={index}
            ref={(node) => {
              pages.current[index] = node;
            }}
            pdf={pdf}
            index={index}
            size={size}
            scale={scale}
            root={root}
            rects={highlight?.rects.filter((rect) => rect.page === index + 1) ?? []}
            clickable={clickable}
            onPoint={onPoint}
          />
        ))}
      </div>
    </div>
  );
}

interface PdfPageProps {
  ref: (node: HTMLDivElement | null) => void;
  pdf: LoadedPdf;
  index: number;
  size: PageSize;
  scale: number;
  root: HTMLDivElement | null;
  rects: SyncRect[];
  clickable: boolean;
  onPoint: (page: number, x: number, y: number) => void;
}

function PdfPage({ ref, pdf, index, size, scale, root, rects, clickable, onPoint }: PdfPageProps) {
  const element = useRef<HTMLDivElement | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = element.current;
    if (!node || !root) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting ?? false), { root, rootMargin: '1000px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    const target = holder.current;
    if (!target) return;
    // Lejos de la vista: se suelta el canvas (memoria).
    if (!near) {
      target.replaceChildren();
      return;
    }
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      const page = await pdf.doc.getPage(index + 1);
      if (cancelled) return;
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (size.width * scale * size.height * scale)));
      const viewport = page.getViewport({ scale: scale * ratio });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.className = 'block size-full';
      task = page.render({ canvas, viewport });
      await task.promise;
      if (!cancelled) target.replaceChildren(canvas);
    })().catch(() => {
      // Cancelado (otro zoom, otro PDF) o el documento ya se liberó.
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, index, size, scale, near]);

  return (
    <div
      ref={(node) => {
        element.current = node;
        ref(node);
      }}
      role="img"
      aria-label={`Página ${index + 1} de ${pdf.sizes.length}`}
      onClick={(event) => {
        if (!clickable) return;
        const box = event.currentTarget.getBoundingClientRect();
        onPoint(index + 1, (event.clientX - box.left) / scale, (event.clientY - box.top) / scale);
      }}
      className={`relative flex-none bg-white shadow-[0_1px_3px_rgb(0_0_0/0.14),0_8px_24px_rgb(0_0_0/0.10)] ${clickable ? 'cursor-pointer' : ''}`}
      style={{ width: size.width * scale, height: size.height * scale }}
    >
      <div ref={holder} className="absolute inset-0" />
      {rects.map((rect, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="pointer-events-none absolute rounded-sm bg-[#2f45c6]/15 outline-2 outline-offset-1 outline-[#2f45c6]/40"
          style={{ left: rect.x * scale, top: rect.y * scale, width: rect.width * scale, height: rect.height * scale }}
        />
      ))}
    </div>
  );
}
