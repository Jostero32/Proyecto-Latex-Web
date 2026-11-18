// Compilar el proyecto: espera a que el server tenga lo escrito, encola la compilación y consulta su
// estado cada segundo hasta que termina. Recuerda el último PDF bueno: si la siguiente no da PDF, el
// panel sigue mostrando ese (atenuado).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Compilation, CompilationResponse } from '@latexweb/shared';
import { api, errorMessage, isApiError } from '../../lib/api';

export type CompilePhase = 'idle' | 'queued' | 'running' | 'busy';

export interface CompileResult {
  status: 'success' | 'error' | 'timeout' | 'failed';
  durationMs: number;
  errorCount: number;
  /** Esta compilación publicó un PDF (con errores también puede pasar). */
  hasPdf: boolean;
  /** El PDF se generó pero superaba el tamaño máximo. */
  pdfTooLarge: boolean;
  /** Por qué no se pudo compilar (`failed`), si lo sabemos. */
  message?: string;
}

/** El PDF que se muestra y lo que va con él (SyncTeX de esa misma compilación). */
export interface ShownPdf {
  compilationId: string;
  url: string;
  synctexUrl: string | null;
  /** El documento principal con el que se compiló (ancla las rutas del SyncTeX). */
  mainFile: string;
}

const POLL_MS = 1000;
/** Más que el tiempo máximo de compilación más una cola larga: después, algo se perdió. */
const GIVE_UP_MS = 10 * 60_000;
/** Errores de red seguidos antes de rendirse. */
const MAX_NETWORK_ERRORS = 10;
const DEFAULT_RETRY_S = 10;

export interface CompileHooks {
  /** Antes de encolar (esperar a que el server tenga lo escrito). */
  beforeCompile: () => Promise<void>;
  /** Terminó (con o sin PDF). */
  onFinish: (compilation: Compilation) => void;
}

export function useCompile(projectId: string, hooks: CompileHooks) {
  const latest = useRef(hooks);
  useEffect(() => {
    latest.current = hooks;
  });
  const [phase, setPhase] = useState<CompilePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [compilation, setCompilation] = useState<Compilation | null>(null);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [pdf, setPdf] = useState<ShownPdf | null>(null);
  const run = useRef<AbortController | null>(null);
  const phaseRef = useRef<CompilePhase>('idle');

  const changePhase = useCallback((next: CompilePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      run.current?.abort();
      clearTimeout(busyTimer.current);
    },
    [],
  );

  // El reloj: segundos compilando, o los que faltan para reintentar con la cola llena.
  useEffect(() => {
    if (phase !== 'running' && phase !== 'busy') return;
    const step = phase === 'running' ? 1 : -1;
    const tick = setInterval(() => setSeconds((s) => s + step), 1000);
    return () => clearInterval(tick);
  }, [phase]);

  const finish = useCallback(
    (done: Compilation) => {
      setCompilation(done);
      setResult(toResult(done));
      if (done.pdfUrl) setPdf({ compilationId: done.id, url: done.pdfUrl, synctexUrl: done.synctexUrl ?? null, mainFile: done.mainFile });
      changePhase('idle');
      latest.current.onFinish(done);
    },
    [changePhase],
  );

  const fail = useCallback(
    (message: string) => {
      setResult({ status: 'failed', durationMs: 0, errorCount: 0, hasPdf: false, pdfTooLarge: false, message });
      changePhase('idle');
    },
    [changePhase],
  );

  const compile = useCallback(async () => {
    if (phaseRef.current !== 'idle') return;
    const controller = new AbortController();
    run.current?.abort();
    run.current = controller;
    const { signal } = controller;
    setSeconds(0);
    changePhase('running');
    try {
      // El server compila su copia del documento: lo último que escribí tiene que haber llegado.
      await latest.current.beforeCompile();
      const started = (await api<CompilationResponse>(`/projects/${encodeURIComponent(projectId)}/compile`, { method: 'POST', signal })).compilation;
      changePhase(started.status === 'queued' ? 'queued' : 'running');
      const deadline = Date.now() + GIVE_UP_MS;
      let networkErrors = 0;
      let current = started;
      while (current.status === 'queued' || current.status === 'running') {
        if (Date.now() > deadline) return fail('La compilación no terminó a tiempo. Reintentá en un momento.');
        await wait(POLL_MS, signal);
        try {
          current = (await api<CompilationResponse>(`/compilations/${encodeURIComponent(started.id)}`, { signal })).compilation;
          networkErrors = 0;
        } catch (error) {
          if (!isApiError(error, 'network_error') || ++networkErrors >= MAX_NETWORK_ERRORS) throw error;
          continue;
        }
        // (phaseRef cambia durante la espera: TS no lo sabe.)
        if (current.status === 'running' && (phaseRef.current as CompilePhase) === 'queued') {
          setSeconds(0);
          changePhase('running');
        }
      }
      finish(current);
    } catch (error) {
      if (signal.aborted) return;
      if (isApiError(error, 'queue_full')) {
        const retry = error.retryAfter ?? DEFAULT_RETRY_S;
        setSeconds(retry);
        changePhase('busy');
        busyTimer.current = setTimeout(() => changePhase('idle'), retry * 1000);
      } else if (isApiError(error, 'invalid_main_file')) {
        fail('El documento principal no es un .tex del proyecto. Elegí otro en Ajustes del proyecto.');
      } else {
        fail(errorMessage(error));
      }
    }
  }, [projectId, changePhase, finish, fail]);

  return { phase, seconds, compilation, result, pdf, compile };
}

function toResult(compilation: Compilation): CompileResult {
  const status = compilation.status === 'queued' || compilation.status === 'running' ? 'failed' : compilation.status;
  return {
    status,
    durationMs: compilation.durationMs ?? 0,
    errorCount: (compilation.diagnostics ?? []).filter((d) => d.level === 'error').length,
    hasPdf: Boolean(compilation.pdfUrl),
    pdfTooLarge: compilation.pdfMissingReason === 'too_large',
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
