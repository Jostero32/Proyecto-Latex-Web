// Editor: archivos a la izquierda, código al centro, PDF a la derecha y el panel de problemas abajo. Los
// costados se ocultan (queda un riel) y se redimensionan. Paso 1 de docs/specs/frontend.md: datos de
// ejemplo y una compilación simulada.
//   ?vista=exito|errores|lector        los tres estados del diseño
//   ?aviso=permisos|sin-acceso|sin-conexion|doc-grande
//   ?compilar=timeout|fallo|cola|grande  qué devuelve la próxima compilación
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Diagnostic, Engine, ProjectFile } from '@latexweb/shared';
import { Button, IconButton } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { formatBytes } from '../../lib/format';
import {
  DIAGNOSTICS_ERRORS,
  DIAGNOSTICS_SUCCESS,
  DOCUMENT,
  DOCUMENT_WITH_ERRORS,
  FILE_CONTENTS,
  FILES,
  findProject,
  PRESENCE,
  REMOTE_CURSORS,
} from '../../lib/mock';
import { ShareDialog } from '../sharing/ShareDialog';
import { CodeView } from './CodeView';
import { FileSearchDialog, LogDialog, NewFileDialog, SettingsDialog } from './EditorDialogs';
import { FileTree, ImagePlaceholder } from './FileTree';
import { PdfPane, type CompilePhase, type CompileResult } from './PdfPane';
import { ProblemsPanel } from './ProblemsPanel';
import { TopBar, type Connection } from './TopBar';
import { baseName, buildTree, fileIcon, isImage } from './tree';

type Banner = 'permisos' | 'sin-acceso' | 'sin-conexion' | 'doc-grande';
type Dialogs = 'share' | 'settings' | 'new-file' | 'search' | 'log' | 'delete-project' | null;

const pick = <T extends string>(value: string | null, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

/** Lo que se subraya en la línea del error: el comando que falta o el paquete que no existe. */
function culprit(message: string): string | undefined {
  return message.match(/`([^']+)\.sty'/)?.[1] ?? message.match(/\\[a-zA-Z@]+/g)?.at(-1);
}

export function EditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const project = findProject(id);
  const view = pick(params.get('vista'), ['exito', 'errores', 'lector'] as const, 'exito');
  const notice = pick<Banner | 'ninguno'>(params.get('aviso'), ['permisos', 'sin-acceso', 'sin-conexion', 'doc-grande'], 'ninguno');
  const demoCompile = params.get('compilar');
  const errorsView = view === 'errores';
  const role = view === 'lector' ? 'viewer' : project.role;
  const canEdit = role !== 'viewer';

  const [name, setName] = useState(project.name);
  const [files, setFiles] = useState<ProjectFile[]>(FILES);
  const [mainFile, setMainFile] = useState(project.mainFile);
  const [engine, setEngine] = useState<Engine>(project.engine);
  const [tabs, setTabs] = useState(['main.tex', 'capitulos/introduccion.tex', 'referencias.bib']);
  const [active, setActive] = useState<string | null>('main.tex');
  const [left, setLeft] = useState({ open: true, width: 248 });
  // El PDF ocupa 560 px en 1440; en pantallas más chicas, menos, para que el código no quede angosto.
  const [right, setRight] = useState(() => ({ open: true, width: Math.round(Math.min(560, Math.max(380, window.innerWidth * 0.36))) }));
  const [minimap, setMinimap] = useState(view === 'exito');
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [phase, setPhase] = useState<CompilePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState<CompileResult | null>(
    errorsView ? { status: 'error', durationMs: 3100, errorCount: 2 } : { status: 'success', durationMs: 2400, errorCount: 0 },
  );
  const [diagnostics, setDiagnostics] = useState<Diagnostic[] | null>(errorsView ? DIAGNOSTICS_ERRORS : DIAGNOSTICS_SUCCESS);
  const [problemsOpen, setProblemsOpen] = useState(errorsView);
  const [selected, setSelected] = useState<number | null>(errorsView ? 0 : null);
  const [jumpLine, setJumpLine] = useState<number | null>(errorsView ? 28 : null);
  const [syncLine, setSyncLine] = useState<number | null>(null);
  // Las tres vistas arrancan con un PDF bueno de antes; una compilación con errores lo deja atenuado.
  const [hasPdf, setHasPdf] = useState(true);
  const [cursor, setCursor] = useState(errorsView ? { line: 28, column: 39 } : { line: 26, column: 38 });

  const connection: Connection = notice === 'sin-conexion' ? 'sin-conexion' : errorsView ? 'sincronizando' : 'guardado';
  const tree = useMemo(() => buildTree(files), [files]);
  const activeFile = files.find((f) => f.path === active) ?? null;

  // Compilación simulada: en cola → compilando (con el tiempo corriendo) → resultado.
  const compile = useCallback(() => {
    if (phase !== 'idle') return;
    setSyncLine(null);
    if (demoCompile === 'cola') {
      setSeconds(8);
      setPhase('busy');
      return;
    }
    setPhase('queued');
  }, [phase, demoCompile]);

  useEffect(() => {
    if (phase === 'queued') {
      const timer = setTimeout(() => {
        setSeconds(0);
        setPhase('running');
      }, 700);
      return () => clearTimeout(timer);
    }
    if (phase === 'running') {
      const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
      const done = setTimeout(() => {
        setPhase('idle');
        if (demoCompile === 'timeout') setResult({ status: 'timeout', durationMs: 120_000, errorCount: 0 });
        else if (demoCompile === 'fallo') setResult({ status: 'failed', durationMs: 0, errorCount: 0 });
        else if (demoCompile === 'grande') setResult({ status: 'success', durationMs: 4200, errorCount: 0, pdfTooLarge: true });
        else if (errorsView) {
          setResult({ status: 'error', durationMs: 2600, errorCount: 2 });
          setDiagnostics(DIAGNOSTICS_ERRORS);
        } else {
          setResult({ status: 'success', durationMs: 1800, errorCount: 0 });
          setHasPdf(true);
          setDiagnostics(DIAGNOSTICS_SUCCESS);
        }
      }, 2300);
      return () => {
        clearInterval(tick);
        clearTimeout(done);
      };
    }
    if (phase === 'busy') {
      const tick = setInterval(() => setSeconds((s) => s - 1), 1000);
      return () => clearInterval(tick);
    }
  }, [phase, demoCompile, errorsView]);

  useEffect(() => {
    if (phase === 'busy' && seconds <= 0) {
      const timer = setTimeout(() => setPhase('idle'), 0);
      return () => clearTimeout(timer);
    }
  }, [phase, seconds]);

  // Atajos: Ctrl/⌘+S y Ctrl/⌘+Enter compilan; Ctrl/⌘+P busca un archivo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 's' || key === 'enter') {
        event.preventDefault();
        compile();
      } else if (key === 'p') {
        event.preventDefault();
        setDialog('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compile]);

  const openFile = (path: string, line: number | null = null) => {
    if (!tabs.includes(path)) setTabs([...tabs, path]);
    setActive(path);
    setJumpLine(line);
    if (line) setCursor({ line, column: 0 });
  };

  const closeTab = (path: string) => {
    const next = tabs.filter((t) => t !== path);
    setTabs(next);
    if (active === path) setActive(next.at(-1) ?? null);
  };

  const lines = useMemo(() => {
    if (!active) return [];
    if (active === 'main.tex') return errorsView ? DOCUMENT_WITH_ERRORS : DOCUMENT;
    return FILE_CONTENTS[active] ?? [''];
  }, [active, errorsView]);

  const errorLines = useMemo(() => {
    const map = new Map<number, string | undefined>();
    if (result?.status !== 'error' || phase !== 'idle') return map;
    for (const d of diagnostics ?? []) if (d.level === 'error' && d.file === active && d.line) map.set(d.line, culprit(d.message));
    return map;
  }, [diagnostics, active, result, phase]);

  const remoteCursors = active === 'main.tex' ? (errorsView ? REMOTE_CURSORS.slice(0, 1) : REMOTE_CURSORS) : [];
  const presence = errorsView ? PRESENCE.slice(0, 2) : PRESENCE;

  if (notice === 'sin-acceso') return <NoAccess />;

  return (
    <div className="flex h-screen min-h-[520px] flex-col overflow-hidden bg-bg text-sm">
      <TopBar
        name={name}
        role={role}
        connection={connection}
        presence={presence}
        onRename={setName}
        onShare={() => setDialog('share')}
        onSettings={() => setDialog('settings')}
        onDelete={() => setDialog('delete-project')}
      />
      {notice === 'permisos' && (
        <Notice tone="info" alert title="Tus permisos cambiaron" className="rounded-none border-b border-border">
          Ahora sos Lector en este proyecto. Recargamos el editor para que puedas seguir mirando y compilando.
        </Notice>
      )}
      {notice === 'sin-conexion' && (
        <Notice tone="warning" icon="cloudOff" title="Sin conexión" className="rounded-none border-b border-border">
          Lo que escribas queda en este navegador y se sincroniza cuando vuelva la conexión.
        </Notice>
      )}
      {notice === 'doc-grande' && (
        <Notice tone="error" alert title="El documento llegó al tamaño máximo (10 MB)" className="rounded-none border-b border-border">
          La edición se cortó para no perder datos. Sacá contenido o dividilo en varios archivos con \input.
        </Notice>
      )}

      <div className="flex min-h-0 flex-1">
        {left.open ? (
          <>
            <div style={{ width: left.width }} className="flex-none">
              <FileTree
                nodes={tree}
                activePath={active}
                mainFile={mainFile}
                canEdit={canEdit}
                onOpen={(path) => openFile(path)}
                onHide={() => setLeft({ ...left, open: false })}
                onSearch={() => setDialog('search')}
                onNewFile={() => setDialog('new-file')}
                onDelete={setDeleting}
                onSetMain={setMainFile}
              />
            </div>
            <Resizer label="Ancho del árbol de archivos" value={left.width} min={180} max={420} onChange={(width) => setLeft({ ...left, width })} />
          </>
        ) : (
          <div className="flex w-12 flex-none flex-col items-center border-r border-border pt-1.5">
            <IconButton icon="panelLeft" size="sm" label="Mostrar archivos" onClick={() => setLeft({ ...left, open: true })} />
          </div>
        )}

        <section aria-label="Editor de código" className="@container flex min-w-0 flex-1 flex-col bg-surface">
          <Tabs tabs={tabs} active={active} readOnly={!canEdit} onSelect={(path) => openFile(path)} onClose={closeTab} />
          {canEdit ? (
            <FormatBar minimap={minimap} onMinimap={() => setMinimap(!minimap)} onSync={() => setSyncLine(cursor.line)} />
          ) : (
            <div role="note" className="flex h-11 flex-none items-center gap-2.5 border-b border-border bg-surface-2 px-3.5 text-[13.5px]">
              <Icon name="eye" size={16} />
              <strong className="font-semibold">Estás en modo lectura.</strong>
              <span className="hidden text-muted md:inline">Podés compilar y descargar, pero no editar.</span>
              <span className="flex-1" />
              <SyncButton onClick={() => setSyncLine(cursor.line)} />
            </div>
          )}
          {activeFile?.kind === 'binary' ? (
            <BinaryView file={activeFile} />
          ) : active ? (
            <CodeView
              path={active}
              lines={lines}
              errors={errorLines}
              jumpLine={jumpLine}
              cursor={active === 'main.tex' ? cursor : null}
              remoteCursors={remoteCursors}
              readOnly={!canEdit || notice === 'doc-grande'}
              minimap={minimap && canEdit}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-muted">Abrí un archivo del árbol para verlo acá.</div>
          )}
          <ProblemsPanel
            diagnostics={diagnostics}
            open={problemsOpen}
            onToggle={() => setProblemsOpen(!problemsOpen)}
            selected={selected}
            onSelect={(index, d) => {
              setSelected(index);
              if (d.file && d.line && files.some((f) => f.path === d.file)) openFile(d.file, d.line);
            }}
            cursor={active === 'main.tex' ? cursor : null}
            onShowLog={() => setDialog('log')}
          />
        </section>

        {right.open ? (
          <>
            <Resizer label="Ancho del PDF" value={right.width} min={360} max={900} invert onChange={(width) => setRight({ ...right, width })} />
            <div style={{ width: right.width }} className="flex-none">
              <PdfPane
                phase={phase}
                seconds={seconds}
                result={result}
                hasPdf={hasPdf}
                engine={engine}
                canChangeEngine={canEdit}
                syncLine={syncLine}
                onCompile={compile}
                onEngine={setEngine}
                onHide={() => setRight({ ...right, open: false })}
                onShowProblems={() => setProblemsOpen(true)}
                onShowLog={() => setDialog('log')}
                onJumpToLine={(line) => {
                  setSyncLine(line);
                  openFile('main.tex', line);
                }}
              />
            </div>
          </>
        ) : (
          <div className="flex w-[52px] flex-none flex-col items-center gap-1.5 border-l border-border bg-surface pt-2">
            <button
              type="button"
              aria-label="Compilar (Ctrl+S)"
              title="Compilar (Ctrl+S)"
              onClick={compile}
              disabled={phase !== 'idle'}
              className="flex size-[38px] items-center justify-center rounded-md bg-accent text-on-accent disabled:bg-accent-soft disabled:text-accent-text"
            >
              <Icon name={phase === 'idle' ? 'play' : 'spinner'} size={16} filled={phase === 'idle'} className={phase === 'idle' ? '' : 'animate-spin'} />
            </button>
            <IconButton icon="panelRight" size="sm" label="Mostrar PDF" onClick={() => setRight({ ...right, open: true })} />
          </div>
        )}
      </div>

      {role === 'owner' && <ShareDialog open={dialog === 'share'} onClose={() => setDialog(null)} projectName={name} />}
      {dialog === 'settings' && (
        <SettingsDialog
          open
          onClose={() => setDialog(null)}
          name={name}
          isOwner={role === 'owner'}
          mainFile={mainFile}
          engine={engine}
          texFiles={files.filter((f) => f.path.endsWith('.tex')).map((f) => f.path)}
          onSave={(settings) => {
            setMainFile(settings.mainFile);
            setEngine(settings.engine);
          }}
        />
      )}
      <NewFileDialog
        open={dialog === 'new-file'}
        onClose={() => setDialog(null)}
        existing={files.map((f) => f.path)}
        onCreate={(path) => {
          setFiles([...files, { id: path, path, kind: 'text', size: 0, updatedAt: new Date().toISOString() }]);
          openFile(path);
        }}
      />
      <FileSearchDialog open={dialog === 'search'} onClose={() => setDialog(null)} files={files} onOpen={(path) => openFile(path)} />
      <LogDialog open={dialog === 'log'} onClose={() => setDialog(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          setFiles(files.filter((f) => f.path !== deleting));
          if (deleting) closeTab(deleting);
        }}
        title={`¿Borrar ${deleting ? baseName(deleting) : ''}?`}
        confirmLabel="Borrar archivo"
      >
        Se borra para todos los miembros del proyecto. No se puede deshacer.
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'delete-project'}
        onClose={() => setDialog(null)}
        onConfirm={() => navigate('/')}
        title="¿Borrar el proyecto?"
        confirmLabel="Borrar proyecto"
        confirmText={name}
      >
        Se borran todos sus archivos y compilaciones, también para los demás miembros. No se puede deshacer.
      </ConfirmDialog>
    </div>
  );
}

function Tabs({ tabs, active, readOnly, onSelect, onClose }: { tabs: string[]; active: string | null; readOnly: boolean; onSelect: (path: string) => void; onClose: (path: string) => void }) {
  return (
    <div role="tablist" aria-label="Archivos abiertos" className="flex h-10 flex-none items-stretch overflow-x-auto border-b border-border bg-bg [scrollbar-width:none]">
      {tabs.map((path) => {
        const on = path === active;
        return (
          <div
            key={path}
            className={`-mb-px flex max-w-[200px] min-w-0 flex-none items-center border-r border-border ${
              on ? 'bg-surface text-text shadow-[inset_0_2px_0_var(--c-accent)]' : 'text-muted hover:text-text'
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={on}
              title={path}
              onClick={() => onSelect(path)}
              className={`flex h-full min-w-0 items-center gap-[7px] pr-0.5 pl-3 text-[13px] ${on ? 'font-semibold' : 'font-medium'}`}
            >
              <Icon name={readOnly ? 'lock' : fileIcon(path)} size={14} />
              <span className="truncate">{baseName(path)}</span>
            </button>
            <button
              type="button"
              aria-label={`Cerrar ${baseName(path)}`}
              onClick={() => onClose(path)}
              className="mr-1.5 flex size-[26px] flex-none items-center justify-center rounded text-faint hover:bg-surface-2 hover:text-text"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

const FORMAT_BUTTONS = [
  { label: 'Negrita (Ctrl+B)', text: 'B', className: 'font-paper font-bold' },
  { label: 'Cursiva (Ctrl+I)', text: 'I', className: 'font-paper italic' },
  { label: 'Sección', icon: 'heading' },
  { label: 'Lista', icon: 'list' },
  { label: 'Fórmula', icon: 'sigma' },
  { label: 'Insertar figura', icon: 'image' },
  { label: 'Cita', icon: 'quote' },
] as const;

function FormatBar({ minimap, onMinimap, onSync }: { minimap: boolean; onMinimap: () => void; onSync: () => void }) {
  return (
    <div role="toolbar" aria-label="Formato" className="flex h-11 flex-none items-center gap-1 overflow-x-auto border-b border-border bg-surface px-2.5 [scrollbar-width:none]">
      <div className="flex flex-none gap-0.5 rounded-[7px] bg-surface-2 p-[3px]">
        <button type="button" aria-pressed="true" className="h-7 rounded-[5px] bg-surface px-2.5 text-[13px] font-semibold text-text shadow-sm">
          Código
        </button>
        <button
          type="button"
          aria-pressed="false"
          disabled
          title="El modo visual llega pronto"
          className="flex h-7 items-center gap-1.5 rounded-[5px] pr-2 pl-2.5 text-[13px] font-medium text-muted disabled:cursor-not-allowed"
        >
          Visual
          <span className="rounded bg-accent-soft px-1.5 py-px text-[10.5px] font-bold tracking-wide text-accent-text uppercase">Pronto</span>
        </button>
      </div>
      <span aria-hidden="true" className="mx-1.5 h-[22px] w-px flex-none bg-border" />
      {FORMAT_BUTTONS.map((button) =>
        'icon' in button ? (
          <IconButton key={button.label} icon={button.icon} size="xs" label={button.label} className="text-text" />
        ) : (
          <button
            key={button.label}
            type="button"
            aria-label={button.label}
            title={button.label}
            className={`flex size-8 flex-none items-center justify-center rounded-md text-[15px] text-text hover:bg-surface-2 ${button.className}`}
          >
            {button.text}
          </button>
        ),
      )}
      <span className="flex-1" />
      <SyncButton onClick={onSync} />
      <IconButton icon="minimap" size="xs" label="Minimapa" pressed={minimap} onClick={onMinimap} />
    </div>
  );
}

function SyncButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Ver en el PDF la línea del cursor"
      aria-label="Ver en el PDF"
      className="flex h-8 flex-none items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-muted hover:bg-surface-2 hover:text-text"
    >
      <Icon name="target" size={15} />
      <span className="hidden @3xl:inline">Ver en el PDF</span>
    </button>
  );
}

function BinaryView({ file }: { file: ProjectFile }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto bg-bg p-8">
      {isImage(file.path) ? (
        <ImagePlaceholder className="h-[280px] w-full max-w-[420px]" />
      ) : (
        <div className="flex h-40 w-32 items-center justify-center rounded border-[1.5px] border-dashed border-border-input text-muted">
          <Icon name={fileIcon(file.path)} size={32} strokeWidth={1.4} />
        </div>
      )}
      <div className="flex flex-col items-center gap-1 text-center">
        <strong className="font-mono text-[13px] font-semibold break-all">{file.path}</strong>
        <span className="text-[13px] text-muted">
          {formatBytes(file.size)}
          {isImage(file.path) ? '' : ' · Vista previa no disponible'}
        </span>
      </div>
      <Button size="sm" icon="download">
        Descargar
      </Button>
    </div>
  );
}

/** Separador arrastrable entre paneles; con foco, las flechas cambian el ancho de a 16 px. */
function Resizer({ label, value, min, max, invert = false, onChange }: { label: string; value: number; min: number; max: number; invert?: boolean; onChange: (value: number) => void }) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const onPointerDown = (event: ReactPointerEvent) => {
    start.current = { x: event.clientX, value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    if (!start.current) return;
    const delta = event.clientX - start.current.x;
    onChange(clamp(start.current.value + (invert ? -delta : delta)));
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
    if (!step) return;
    event.preventDefault();
    onChange(clamp(value + (invert ? -step : step)));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (start.current = null)}
      onKeyDown={onKeyDown}
      className="group relative w-px flex-none cursor-col-resize bg-border before:absolute before:inset-y-0 before:-right-1 before:-left-1 before:content-['']"
    >
      <span className="absolute top-1/2 -left-0.5 -mt-4 h-8 w-[5px] rounded-[3px] bg-border group-hover:bg-border-input group-focus-visible:bg-accent" />
    </div>
  );
}

function NoAccess() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div role="alert" className="flex max-w-[440px] flex-col items-start gap-4 rounded-2xl border border-border bg-surface p-8 shadow-pop">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted">
          <Icon name="lock" size={22} />
        </span>
        <h1 className="m-0 font-serif text-3xl font-medium">Ya no tenés acceso a este proyecto</h1>
        <p className="m-0 text-[15px] leading-relaxed text-muted">El dueño te quitó del proyecto o lo borró. Si creés que es un error, escribile.</p>
        <Link to="/" className="flex h-11 items-center rounded-md bg-accent px-4 text-sm font-semibold text-on-accent no-underline">
          Ir a mis proyectos
        </Link>
      </div>
    </main>
  );
}
