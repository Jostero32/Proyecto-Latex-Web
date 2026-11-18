// Editor: archivos a la izquierda, código al centro, PDF a la derecha y el panel de problemas abajo. Los
// costados se ocultan (queda un riel) y se redimensionan. Proyecto y árbol vienen de la API; el texto se
// edita en vivo con los demás (Yjs por WebSocket, ver collab.ts). Compilar: compile.ts; el PDF, PdfView;
// ir del código al PDF y volver, synctex.ts.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Compilation, Engine, ProjectFile, ProjectSummary, UpdateProjectRequest } from '@latexweb/shared';
import type * as Y from 'yjs';
import { FullScreenError, FullScreenLoading } from '../../app/RequireAuth';
import { colorFor, type Presence } from '../../components/Avatar';
import { Button, IconButton } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon, type IconName } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { download, errorMessage, fetchApi, isApiError } from '../../lib/api';
import { formatBytes, MOD_KEY } from '../../lib/format';
import { useCurrentUser } from '../auth/api';
import { exportUrl, projectKey, projectsKey, useDeleteProject, useProject, useUpdateProject } from '../projects/api';
import { ShareDialog } from '../sharing/ShareDialog';
import { fileUrl, filesKey, useDeleteFile, useFiles, useRenameFile, useUploadFiles, type Upload } from './api';
import { useCollab } from './collab';
import { useCompile } from './compile';
import { FileSearchDialog, LogDialog, NewFileDialog, RenameFileDialog, SettingsDialog } from './EditorDialogs';
import { FileTree } from './FileTree';
import { LatexEditor, type ErrorLines, type FormatAction, type LatexEditorHandle } from './LatexEditor';
import { PdfPane } from './PdfPane';
import { ProblemsPanel } from './ProblemsPanel';
import { forwardSearch, inverseSearch, loadSynctex, parseSynctex, type SyncRect } from './synctex';
import { TopBar, type Connection } from './TopBar';
import { baseName, buildTree, fileIcon, isImage } from './tree';

type Dialogs = 'share' | 'settings' | 'new-file' | 'search' | 'log' | 'delete-project' | null;

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
  const navigate = useNavigate();
  const client = useQueryClient();
  const me = useCurrentUser();
  const id = project.id;

  // Avisos del server por el WebSocket: alguien cambió el árbol o los datos del proyecto.
  const onServerNotice = useCallback(
    (notice: string) => {
      if (notice === 'files-changed') void client.invalidateQueries({ queryKey: filesKey(id) });
      if (notice === 'project-changed') {
        void client.invalidateQueries({ queryKey: projectKey(id) });
        void client.invalidateQueries({ queryKey: projectsKey });
      }
    },
    [client, id],
  );
  const collab = useCollab(id, me, onServerNotice);
  const role = project.role;
  const canEdit = role !== 'viewer';

  // Al cambiar los permisos, el rol del proyecto también cambió: hay que volver a leerlo.
  useEffect(() => {
    if (collab.notice === 'permisos') void client.invalidateQueries({ queryKey: projectKey(id) });
  }, [collab.notice, client, id]);

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
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [deleting, setDeleting] = useState<ProjectFile | null>(null);
  const [renaming, setRenaming] = useState<ProjectFile | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const editor = useRef<LatexEditorHandle>(null);

  const [problemsOpen, setProblemsOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [jump, setJump] = useState<{ line: number; key: number } | null>(null);
  const [highlight, setHighlight] = useState<{ rects: SyncRect[]; key: number } | null>(null);
  const [pdfMessage, setPdfMessage] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);

  const tree = useMemo(() => buildTree(files), [files]);
  const paths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  // Una pestaña de un archivo borrado o movido por otra persona desaparece sola.
  const tabs = openTabs.filter((path) => paths.has(path));
  const activePath = active && paths.has(active) ? active : (tabs.at(-1) ?? null);
  const activeFile = files.find((f) => f.path === activePath) ?? null;
  const activeId = activeFile?.id ?? null;

  // El Y.Text del archivo abierto (filesVersion: se agregó o quitó un archivo del documento).
  const { doc, filesVersion, setFile } = collab;
  const text = useMemo<Y.Text | null>(
    () => (doc && activeFile?.kind === 'text' ? (doc.getMap<Y.Text>('files').get(activeFile.id) ?? null) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, activeFile?.id, activeFile?.kind, filesVersion],
  );

  useEffect(() => setFile(activeId), [activeId, setFile]);

  const docTooLarge = collab.notice === 'doc-grande';
  const readOnly = !canEdit || collab.readOnly || docTooLarge;
  const connection: Connection =
    collab.status === 'disconnected'
      ? 'sin-conexion'
      : collab.status === 'connecting' || !collab.synced || collab.unsynced > 0
        ? 'sincronizando'
        : 'guardado';

  // Compilar: el server compila su copia, así que primero espera (hasta 3 s) a que tenga lo escrito.
  const { whenSaved } = collab;
  const compiler = useCompile(id, {
    beforeCompile: () => whenSaved(3000),
    onFinish: (done: Compilation) => {
      setSelected(null);
      setHighlight(null);
      if (done.diagnostics?.some((d) => d.level === 'error')) setProblemsOpen(true);
    },
  });
  const { phase, result, pdf } = compiler;
  const runCompile = compiler.compile;
  const compile = useCallback(() => void runCompile(), [runCompile]);
  const { compilation } = compiler;
  const diagnostics = useMemo(() => (compilation ? (compilation.diagnostics ?? []) : null), [compilation]);

  // El SyncTeX del PDF que se muestra (se baja una vez por compilación).
  const synctexText = useQuery({
    queryKey: ['synctex', pdf?.synctexUrl],
    enabled: Boolean(pdf?.synctexUrl),
    staleTime: Infinity,
    gcTime: 60_000,
    queryFn: async ({ signal }) => (pdf?.synctexUrl ? loadSynctex(await fetchApi(pdf.synctexUrl, signal)) : ''),
  });
  const filePaths = useMemo(() => files.map((f) => f.path), [files]);
  const sync = useMemo(
    () => (synctexText.data && pdf ? parseSynctex(synctexText.data, filePaths, pdf.mainFile) : null),
    [synctexText.data, filePaths, pdf],
  );

  // El aviso sobre el PDF se va solo.
  useEffect(() => {
    if (!pdfMessage) return;
    const timer = setTimeout(() => setPdfMessage(null), 3500);
    return () => clearTimeout(timer);
  }, [pdfMessage]);

  /** Código → PDF: marca en el PDF la línea del cursor. */
  const showInPdf = () => {
    setRight((value) => ({ ...value, open: true }));
    if (!pdf) return setPdfMessage('Compilá primero para ver la línea en el PDF.');
    if (!sync) {
      return setPdfMessage(
        synctexText.isError
          ? isApiError(synctexText.error, 'expired')
            ? 'La compilación venció: volvé a compilar.'
            : 'No pudimos leer la ubicación del PDF.'
          : pdf.synctexUrl
            ? 'Un momento: todavía estamos leyendo el PDF.'
            : 'Esta compilación no permite ubicar líneas en el PDF.',
      );
    }
    if (!activePath || activeFile?.kind !== 'text') return;
    const rects = forwardSearch(sync, activePath, cursor?.line ?? 1);
    if (rects.length === 0) return setPdfMessage('Esa parte del código no aparece en el PDF.');
    setHighlight({ rects, key: Date.now() });
  };

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
    if (line) setJump({ line, key: Date.now() });
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

  const errorLines = useMemo<ErrorLines>(() => {
    const map: ErrorLines = new Map();
    if (phase !== 'idle') return map;
    for (const d of diagnostics ?? []) if (d.level === 'error' && d.file === activePath && d.line) map.set(d.line, culprit(d.message));
    return map;
  }, [diagnostics, activePath, phase]);

  const pathById = useMemo(() => new Map(files.map((f) => [f.id, f.path])), [files]);
  const presence: Presence[] = [
    { name: me.name, email: me.email, color: colorFor(me.id), you: true },
    ...collab.peers
      .filter((peer) => peer.userId !== me.id)
      .map((peer) => ({ name: peer.name, email: peer.email, color: peer.color, file: peer.fileId ? pathById.get(peer.fileId) : undefined })),
  ];

  if (collab.denied) return <NoAccess title="Ya no tenés acceso a este proyecto" text="El dueño te quitó del proyecto o lo borró. Si creés que es un error, escribile." />;

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
      {collab.notice === 'permisos' && (
        <Notice
          tone="info"
          alert
          title="Tus permisos cambiaron"
          className="rounded-none border-b border-border"
          actions={
            <Button size="sm" variant="ghost" onClick={collab.dismissNotice}>
              Entendido
            </Button>
          }
        >
          {canEdit ? 'Reconectamos el editor con tu rol nuevo.' : 'Ahora sos Lector en este proyecto: podés mirar y compilar, pero no editar.'}
        </Notice>
      )}
      {collab.status === 'disconnected' && (
        <Notice tone="warning" icon="cloudOff" title="Sin conexión" className="rounded-none border-b border-border">
          Lo que escribas queda en este navegador y se sincroniza cuando vuelva la conexión.
        </Notice>
      )}
      {docTooLarge && (
        <Notice tone="error" alert title="El documento llegó al tamaño máximo (10 MB)" className="rounded-none border-b border-border">
          El último cambio no se guardó y la edición quedó en pausa. Sacá contenido o dividilo en varios archivos con \input y recargá la página.
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
          <Tabs tabs={tabs} active={activePath} readOnly={readOnly} onSelect={(path) => openFile(path)} onClose={closeTab} />
          {activeFile?.kind === 'binary' ? null : !readOnly ? (
            <FormatBar onFormat={(action) => editor.current?.format(action)} onSync={showInPdf} />
          ) : (
            <div role="note" className="flex h-11 flex-none items-center gap-2.5 border-b border-border bg-surface-2 px-3.5 text-[13.5px]">
              <Icon name="eye" size={16} />
              <strong className="font-semibold">{canEdit ? 'Edición en pausa.' : 'Estás en modo lectura.'}</strong>
              <span className="hidden text-muted md:inline">
                {canEdit ? (collab.synced ? 'No se puede editar este documento ahora.' : 'Esperando la conexión con el servidor…') : 'Podés compilar y descargar, pero no editar.'}
              </span>
              <span className="flex-1" />
              <SyncButton onClick={showInPdf} />
            </div>
          )}
          {activeFile?.kind === 'binary' ? (
            <BinaryView file={activeFile} url={fileUrl(id, activeFile.id)} />
          ) : !activePath ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-muted">Abrí un archivo del árbol para verlo acá.</div>
          ) : text && collab.awareness && collab.synced ? (
            <LatexEditor
              ref={editor}
              text={text}
              awareness={collab.awareness}
              readOnly={readOnly}
              errors={errorLines}
              jump={jump}
              onCursor={setCursor}
              label={`Código de ${activePath}`}
            />
          ) : collab.synced ? (
            <div className="flex flex-1 items-start p-6">
              <Notice tone="warning" title="No encontramos el texto de este archivo">
                Puede que lo hayan borrado recién. Probá abrirlo de nuevo desde el árbol.
              </Notice>
            </div>
          ) : (
            <div aria-busy="true" aria-label="Conectando con el documento" className="flex flex-1 flex-col gap-2.5 p-5">
              {[60, 45, 70, 30, 55].map((width, index) => (
                <span key={index} className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${width}%` }} />
              ))}
            </div>
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
            cursor={activeFile?.kind === 'text' ? cursor : null}
            onShowLog={() => setDialog('log')}
          />
        </section>

        {right.open ? (
          <>
            <Resizer label="Ancho del PDF" value={right.width} min={360} max={900} invert onChange={(width) => setRight({ ...right, width })} />
            <div style={{ width: right.width }} className="flex-none">
              <PdfPane
                phase={phase}
                seconds={compiler.seconds}
                result={result}
                pdfUrl={pdf?.url ?? null}
                engine={project.engine}
                canChangeEngine={canEdit}
                highlight={highlight}
                canSync={sync !== null}
                message={pdfMessage}
                onCompile={compile}
                onEngine={(engine: Engine) => saveProject({ engine })}
                onHide={() => setRight({ ...right, open: false })}
                onShowProblems={() => setProblemsOpen(true)}
                onShowLog={() => setDialog('log')}
                onDownload={() => pdf && download(pdf.url, `${project.name}.pdf`)}
                onPoint={(page, x, y) => {
                  const target = sync ? inverseSearch(sync, page, x, y) : null;
                  if (target && paths.has(target.path)) openFile(target.path, target.line);
                  else setPdfMessage('No encontramos el código de esa parte del PDF.');
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
      <LogDialog open={dialog === 'log'} onClose={() => setDialog(null)} logUrl={compiler.compilation?.logUrl ?? null} compiled={compiler.compilation !== null} />
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

const FORMAT_BUTTONS: { action: FormatAction; label: string; text?: string; className?: string; icon?: IconName }[] = [
  { action: 'bold', label: `Negrita (${MOD_KEY}+B)`, text: 'B', className: 'font-paper font-bold' },
  { action: 'italic', label: `Cursiva (${MOD_KEY}+I)`, text: 'I', className: 'font-paper italic' },
  { action: 'section', label: 'Sección', icon: 'heading' },
  { action: 'list', label: 'Lista', icon: 'list' },
  { action: 'formula', label: 'Fórmula', icon: 'sigma' },
  { action: 'figure', label: 'Insertar figura', icon: 'image' },
  { action: 'cite', label: 'Cita', icon: 'quote' },
];

function FormatBar({ onFormat, onSync }: { onFormat: (action: FormatAction) => void; onSync: () => void }) {
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
      {FORMAT_BUTTONS.map((button) => (
        <button
          key={button.action}
          type="button"
          aria-label={button.label}
          title={button.label}
          // Sin robar el foco: el editor conserva la selección que se va a envolver.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onFormat(button.action)}
          className={`flex size-8 flex-none items-center justify-center rounded-md text-[15px] text-text hover:bg-surface-2 ${button.className ?? ''}`}
        >
          {button.icon ? <Icon name={button.icon} size={16} /> : button.text}
        </button>
      ))}
      <span className="flex-1" />
      <SyncButton onClick={onSync} />
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
