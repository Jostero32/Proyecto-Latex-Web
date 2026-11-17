// Editor: archivos a la izquierda, código al centro, PDF a la derecha y el panel de problemas abajo. Los
// costados se ocultan (queda un riel) y se redimensionan. Proyecto, árbol y archivos vienen de la API; el
// texto todavía se ve sin editar (paso 3: CodeMirror y Yjs) y la compilación es simulada (paso 4).
// Demos de lo que falta conectar:
//   ?vista=exito|errores                  el documento, colaboradores y resultados del diseño
//   ?aviso=permisos|sin-acceso|sin-conexion|doc-grande
//   ?compilar=timeout|fallo|cola|grande   qué devuelve la próxima compilación simulada
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Diagnostic, Engine, ProjectFile, ProjectSummary, UpdateProjectRequest } from '@latexweb/shared';
import { FullScreenError, FullScreenLoading } from '../../app/RequireAuth';
import { COLLABORATOR_COLORS, type Presence } from '../../components/Avatar';
import { Button, IconButton } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { download, errorMessage, isApiError } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { DIAGNOSTICS_ERRORS, DIAGNOSTICS_SUCCESS, DOCUMENT, DOCUMENT_WITH_ERRORS, PRESENCE, REMOTE_CURSORS } from '../../lib/mock';
import { useCurrentUser } from '../auth/api';
import { exportUrl, useDeleteProject, useProject, useUpdateProject } from '../projects/api';
import { ShareDialog } from '../sharing/ShareDialog';
import { fileUrl, useDeleteFile, useFiles, useFileText, useRenameFile, useUploadFiles, type Upload } from './api';
import { CodeView } from './CodeView';
import { FileSearchDialog, LogDialog, NewFileDialog, RenameFileDialog, SettingsDialog } from './EditorDialogs';
import { FileTree } from './FileTree';
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

/** Mensaje de un error al cambiar archivos o el proyecto. */
function changeError(error: unknown): string {
  if (isApiError(error, 'path_conflict')) return 'Ya hay un archivo con esa ruta.';
  if (isApiError(error, 'file_too_large')) return 'El archivo supera los 50 MB.';
  if (isApiError(error, 'project_too_large') || isApiError(error, 'payload_too_large')) return 'El proyecto superaría los 200 MB.';
  if (isApiError(error, 'too_many_files')) return 'El proyecto superaría los 500 archivos.';
  if (isApiError(error, 'invalid_main_file')) return 'El documento principal tiene que ser un .tex del proyecto.';
  return errorMessage(error);
}

export function EditorPage() {
  const { id = '' } = useParams();
  const project = useProject(id);
  const files = useFiles(id);
  if (project.isPending || (project.isSuccess && files.isPending)) return <FullScreenLoading />;
  if (project.isError) {
    return isApiError(project.error, 'not_found') ? (
      <NoAccess title="Este proyecto no existe o no tenés acceso" text="Puede que lo hayan borrado o que te hayan quitado del proyecto." />
    ) : (
      <FullScreenError message={errorMessage(project.error)} onRetry={() => void project.refetch()} />
    );
  }
  if (files.isError) return <FullScreenError message={errorMessage(files.error)} onRetry={() => void files.refetch()} />;
  return <Editor project={project.data} files={files.data ?? []} />;
}

function Editor({ project, files }: { project: ProjectSummary; files: ProjectFile[] }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const me = useCurrentUser();
  const demo = pick<'exito' | 'errores' | 'ninguna'>(params.get('vista'), ['exito', 'errores'], 'ninguna');
  const notice = pick<Banner | 'ninguno'>(params.get('aviso'), ['permisos', 'sin-acceso', 'sin-conexion', 'doc-grande'], 'ninguno');
  const demoCompile = params.get('compilar');
  const errorsView = demo === 'errores';
  const role = project.role;
  const canEdit = role !== 'viewer';
  const id = project.id;

  const update = useUpdateProject(id);
  const upload = useUploadFiles(id);
  const renameFile = useRenameFile(id);
  const deleteFile = useDeleteFile(id);
  const deleteProject = useDeleteProject();
  const [failure, setFailure] = useState<string | null>(null);
  const onError = (error: unknown) => setFailure(changeError(error));

  const [openTabs, setOpenTabs] = useState<string[]>(() => [project.mainFile]);
  const [active, setActive] = useState<string | null>(project.mainFile);
  const [left, setLeft] = useState({ open: true, width: 248 });
  // El PDF ocupa 560 px en 1440; en pantallas más chicas, menos, para que el código no quede angosto.
  const [right, setRight] = useState(() => ({ open: true, width: Math.round(Math.min(560, Math.max(380, window.innerWidth * 0.36))) }));
  const [minimap, setMinimap] = useState(demo === 'exito');
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [deleting, setDeleting] = useState<ProjectFile | null>(null);
  const [renaming, setRenaming] = useState<ProjectFile | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<CompilePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState<CompileResult | null>(
    errorsView ? { status: 'error', durationMs: 3100, errorCount: 2 } : demo === 'exito' ? { status: 'success', durationMs: 2400, errorCount: 0 } : null,
  );
  const [diagnostics, setDiagnostics] = useState<Diagnostic[] | null>(errorsView ? DIAGNOSTICS_ERRORS : demo === 'exito' ? DIAGNOSTICS_SUCCESS : null);
  // Las demos arrancan con un PDF bueno de antes; una compilación con errores lo deja atenuado.
  const [hasPdf, setHasPdf] = useState(demo !== 'ninguna');
  const [problemsOpen, setProblemsOpen] = useState(errorsView);
  const [selected, setSelected] = useState<number | null>(errorsView ? 0 : null);
  const [jumpLine, setJumpLine] = useState<number | null>(errorsView ? 28 : null);
  const [syncLine, setSyncLine] = useState<number | null>(null);
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(
    errorsView ? { line: 28, column: 39 } : demo === 'exito' ? { line: 26, column: 38 } : null,
  );

  const connection: Connection = notice === 'sin-conexion' ? 'sin-conexion' : errorsView ? 'sincronizando' : 'guardado';
  const tree = useMemo(() => buildTree(files), [files]);
  const paths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  // Una pestaña de un archivo borrado o movido por otra persona desaparece sola.
  const tabs = openTabs.filter((path) => paths.has(path));
  const activePath = active && paths.has(active) ? active : (tabs.at(-1) ?? null);
  const activeFile = files.find((f) => f.path === activePath) ?? null;
  const usesDemoDocument = demo !== 'ninguna' && activePath === project.mainFile;
  const text = useFileText(id, usesDemoDocument ? null : activeFile);

  // Compilación simulada (paso 4): en cola → compilando (con el tiempo corriendo) → resultado.
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
          setDiagnostics(demo === 'exito' ? DIAGNOSTICS_SUCCESS : []);
          setHasPdf(true);
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
  }, [phase, demoCompile, errorsView, demo]);

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
    if (!tabs.includes(path)) setOpenTabs([...tabs, path]);
    setActive(path);
    setJumpLine(line);
    if (line) setCursor({ line, column: 0 });
  };

  const closeTab = (path: string) => {
    const next = tabs.filter((t) => t !== path);
    setOpenTabs(next);
    if (activePath === path) setActive(next.at(-1) ?? null);
  };

  const sendUploads = (uploads: Upload[], open?: string) => {
    if (uploads.length === 0) return;
    setFailure(null);
    upload.mutate(uploads, { onSuccess: () => open && openFile(open), onError });
  };

  const saveProject = (changes: UpdateProjectRequest, onSuccess?: () => void) => {
    setFailure(null);
    update.mutate(changes, { onSuccess, onError });
  };

  const lines = useMemo(() => {
    if (usesDemoDocument) return errorsView ? DOCUMENT_WITH_ERRORS : DOCUMENT;
    return text.data?.split('\n') ?? [];
  }, [usesDemoDocument, errorsView, text.data]);

  const errorLines = useMemo(() => {
    const map = new Map<number, string | undefined>();
    if (result?.status !== 'error' || phase !== 'idle') return map;
    for (const d of diagnostics ?? []) if (d.level === 'error' && d.file === activePath && d.line) map.set(d.line, culprit(d.message));
    return map;
  }, [diagnostics, activePath, result, phase]);

  const you: Presence = { name: me.name, email: me.email, color: COLLABORATOR_COLORS[0], you: true };
  const presence = demo === 'ninguna' ? [you] : [you, ...PRESENCE.slice(0, errorsView ? 1 : 2)];
  const remoteCursors = usesDemoDocument ? (errorsView ? REMOTE_CURSORS.slice(0, 1) : REMOTE_CURSORS) : [];

  if (notice === 'sin-acceso') return <NoAccess title="Ya no tenés acceso a este proyecto" text="El dueño te quitó del proyecto o lo borró. Si creés que es un error, escribile." />;

  return (
    <div className="flex h-screen min-h-[520px] flex-col overflow-hidden bg-bg text-sm">
      <TopBar
        name={project.name}
        role={role}
        connection={connection}
        presence={presence}
        onRename={(name) => saveProject({ name })}
        onShare={() => setDialog('share')}
        onSettings={() => setDialog('settings')}
        onDelete={() => setDialog('delete-project')}
        onDownload={() => download(exportUrl(id))}
      />
      {failure && (
        <Notice
          tone="error"
          alert
          title="No se pudo hacer el cambio"
          className="rounded-none border-b border-border"
          actions={
            <Button size="sm" variant="ghost" onClick={() => setFailure(null)}>
              Cerrar
            </Button>
          }
        >
          {failure}
        </Notice>
      )}
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

      <input
        ref={picker}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          sendUploads([...(event.target.files ?? [])].map((file) => ({ path: file.name, data: file })));
          event.target.value = '';
        }}
      />

      <div className="flex min-h-0 flex-1">
        {left.open ? (
          <>
            <div style={{ width: left.width }} className="flex-none">
              <FileTree
                nodes={tree}
                activePath={activePath}
                mainFile={project.mainFile}
                canEdit={canEdit}
                uploading={upload.isPending}
                fileUrl={(file) => fileUrl(id, file.id)}
                onOpen={(path) => openFile(path)}
                onHide={() => setLeft({ ...left, open: false })}
                onSearch={() => setDialog('search')}
                onNewFile={() => setDialog('new-file')}
                onPickFiles={() => picker.current?.click()}
                onDropFiles={(folder, dropped) => sendUploads(dropped.map((file) => ({ path: folder ? `${folder}/${file.name}` : file.name, data: file })))}
                onRename={setRenaming}
                onDelete={setDeleting}
                onSetMain={(path) => saveProject({ mainFile: path })}
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
          <Tabs tabs={tabs} active={activePath} readOnly={!canEdit} onSelect={(path) => openFile(path)} onClose={closeTab} />
          {activeFile?.kind === 'binary' ? null : canEdit ? (
            <FormatBar minimap={minimap} onMinimap={() => setMinimap(!minimap)} onSync={() => setSyncLine(cursor?.line ?? 1)} />
          ) : (
            <div role="note" className="flex h-11 flex-none items-center gap-2.5 border-b border-border bg-surface-2 px-3.5 text-[13.5px]">
              <Icon name="eye" size={16} />
              <strong className="font-semibold">Estás en modo lectura.</strong>
              <span className="hidden text-muted md:inline">Podés compilar y descargar, pero no editar.</span>
              <span className="flex-1" />
              <SyncButton onClick={() => setSyncLine(cursor?.line ?? 1)} />
            </div>
          )}
          {activeFile?.kind === 'binary' ? (
            <BinaryView file={activeFile} url={fileUrl(id, activeFile.id)} />
          ) : activePath && text.isError ? (
            <div className="flex flex-1 items-start p-6">
              <Notice tone="error" title="No pudimos abrir el archivo" actions={<Button size="sm" icon="sync" onClick={() => void text.refetch()}>Reintentar</Button>}>
                {errorMessage(text.error)}
              </Notice>
            </div>
          ) : activePath && text.isLoading ? (
            <div aria-busy="true" className="flex flex-1 flex-col gap-2.5 p-5">
              {[60, 45, 70, 30, 55].map((width, index) => (
                <span key={index} className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${width}%` }} />
              ))}
            </div>
          ) : activePath ? (
            <CodeView
              path={activePath}
              lines={lines}
              errors={errorLines}
              jumpLine={jumpLine}
              cursor={activePath === project.mainFile ? cursor : null}
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
              if (d.file && d.line && paths.has(d.file)) openFile(d.file, d.line);
            }}
            cursor={activePath === project.mainFile ? cursor : null}
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
                sample={demo === 'ninguna'}
                engine={project.engine}
                canChangeEngine={canEdit}
                syncLine={syncLine}
                onCompile={compile}
                onEngine={(engine: Engine) => saveProject({ engine })}
                onHide={() => setRight({ ...right, open: false })}
                onShowProblems={() => setProblemsOpen(true)}
                onShowLog={() => setDialog('log')}
                onJumpToLine={(line) => {
                  setSyncLine(line);
                  openFile(project.mainFile, line);
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

      {role === 'owner' && <ShareDialog open={dialog === 'share'} onClose={() => setDialog(null)} projectId={id} projectName={project.name} />}
      {dialog === 'settings' && (
        <SettingsDialog
          open
          onClose={() => setDialog(null)}
          name={project.name}
          isOwner={role === 'owner'}
          mainFile={project.mainFile}
          engine={project.engine}
          texFiles={files.filter((f) => /\.tex$/i.test(f.path)).map((f) => f.path)}
          saving={update.isPending}
          onSave={(changes) => saveProject(changes, () => setDialog(null))}
        />
      )}
      <NewFileDialog
        open={dialog === 'new-file'}
        onClose={() => setDialog(null)}
        existing={files.map((f) => f.path)}
        onCreate={(path) => sendUploads([{ path, data: new Blob([], { type: 'text/plain' }) }], path)}
      />
      {renaming && (
        <RenameFileDialog
          path={renaming.path}
          existing={files.map((f) => f.path)}
          onClose={() => setRenaming(null)}
          onRename={(path) => {
            const from = renaming.path;
            setFailure(null);
            renameFile.mutate(
              { fileId: renaming.id, path },
              {
                onSuccess: () => {
                  setOpenTabs(tabs.map((t) => (t === from ? path : t)));
                  if (activePath === from) setActive(path);
                },
                onError,
              },
            );
            setRenaming(null);
          }}
        />
      )}
      <FileSearchDialog open={dialog === 'search'} onClose={() => setDialog(null)} files={files} onOpen={(path) => openFile(path)} />
      <LogDialog open={dialog === 'log'} onClose={() => setDialog(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          const path = deleting.path;
          setFailure(null);
          deleteFile.mutate(deleting.id, { onSuccess: () => closeTab(path), onError });
        }}
        title={`¿Borrar ${deleting ? baseName(deleting.path) : ''}?`}
        confirmLabel="Borrar archivo"
      >
        Se borra para todos los miembros del proyecto. No se puede deshacer.
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'delete-project'}
        onClose={() => setDialog(null)}
        onConfirm={() => deleteProject.mutate(id, { onSuccess: () => navigate('/', { replace: true }), onError })}
        title="¿Borrar el proyecto?"
        confirmLabel="Borrar proyecto"
        confirmText={project.name}
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

function BinaryView({ file, url }: { file: ProjectFile; url: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto bg-bg p-8">
      {isImage(file.path) ? (
        <img src={url} alt={baseName(file.path)} className="max-h-[60vh] max-w-full rounded-md border border-border bg-white object-contain" />
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
      <Button size="sm" icon="download" onClick={() => download(url)}>
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

function NoAccess({ title, text }: { title: string; text: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div role="alert" className="flex max-w-[440px] flex-col items-start gap-4 rounded-2xl border border-border bg-surface p-8 shadow-pop">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted">
          <Icon name="lock" size={22} />
        </span>
        <h1 className="m-0 font-serif text-3xl font-medium">{title}</h1>
        <p className="m-0 text-[15px] leading-relaxed text-muted">{text}</p>
        <Link to="/" className="flex h-11 items-center rounded-md bg-accent px-4 text-sm font-semibold text-on-accent no-underline">
          Ir a mis proyectos
        </Link>
      </div>
    </main>
  );
}
