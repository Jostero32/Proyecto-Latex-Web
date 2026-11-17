// Árbol de archivos: carpetas plegables, ícono por tipo, estrella en el documento principal, vista previa
// de imágenes al pasar el mouse y menú por archivo (también con clic derecho). Los lectores solo abren y
// descargan. Arrastrar archivos a una carpeta (o al árbol) los sube ahí.
import { useState, type DragEvent, type MouseEvent } from 'react';
import type { ProjectFile } from '@latexweb/shared';
import { IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Menu, type MenuItem } from '../../components/Menu';
import { download } from '../../lib/api';
import { formatBytes, MOD_KEY } from '../../lib/format';
import { fileIcon, isImage, type FileNode, type TreeNode } from './tree';

interface FileTreeProps {
  nodes: TreeNode[];
  activePath: string | null;
  mainFile: string;
  canEdit: boolean;
  /** Hay una subida en curso. */
  uploading: boolean;
  fileUrl: (file: ProjectFile) => string;
  onOpen: (path: string) => void;
  onHide: () => void;
  onSearch: () => void;
  onNewFile: () => void;
  onPickFiles: () => void;
  onDropFiles: (folder: string, files: File[]) => void;
  onRename: (file: ProjectFile) => void;
  onDelete: (file: ProjectFile) => void;
  onSetMain: (path: string) => void;
}

export function FileTree(props: FileTreeProps) {
  const { nodes, activePath, mainFile, canEdit, uploading, onHide, onSearch, onNewFile, onPickFiles, onDropFiles } = props;
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const toggle = (path: string) => {
    const next = new Set(closed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setClosed(next);
  };

  const onDragOver = (event: DragEvent, folder: string) => {
    if (!canEdit || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(folder);
  };

  const renderNodes = (list: TreeNode[], level: number) =>
    list.map((node) =>
      node.type === 'folder' ? (
        <li key={node.path} role="treeitem" aria-expanded={!closed.has(node.path)} aria-selected={false} onDragOver={(event) => onDragOver(event, node.path)}>
          <button
            type="button"
            onClick={() => toggle(node.path)}
            style={{ paddingLeft: 6 + level * 16 }}
            className={`flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[13.5px] ${
              dropTarget === node.path ? 'bg-accent-soft outline-[1.5px] -outline-offset-[1.5px] outline-accent outline-dashed' : 'hover:bg-surface-2'
            }`}
          >
            <Icon name={closed.has(node.path) ? 'chevRight' : 'chevDown'} size={14} className="text-faint" />
            <Icon name={closed.has(node.path) ? 'folder' : 'folderOpen'} size={16} className="text-muted" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </button>
          {!closed.has(node.path) && (
            <ul role="group" className="m-0 flex list-none flex-col gap-px p-0">
              {renderNodes(node.children, level + 1)}
            </ul>
          )}
        </li>
      ) : (
        <FileItem
          key={node.path}
          node={node}
          level={level}
          active={node.path === activePath}
          main={node.path === mainFile}
          canEdit={canEdit}
          url={props.fileUrl(node.file)}
          onOpen={() => props.onOpen(node.path)}
          onRename={() => props.onRename(node.file)}
          onDelete={() => props.onDelete(node.file)}
          onSetMain={() => props.onSetMain(node.path)}
        />
      ),
    );

  return (
    <nav
      aria-label="Archivos del proyecto"
      className="flex h-full min-h-0 flex-col bg-bg"
      onDragOver={(event) => onDragOver(event, '')}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const files = [...event.dataTransfer.files];
        if (canEdit && files.length > 0) onDropFiles(dropTarget ?? '', files);
        setDropTarget(null);
      }}
    >
      <div className="flex h-11 flex-none items-center gap-0.5 pr-1.5 pl-3.5">
        <span className="flex-1 text-xs font-semibold tracking-wider text-muted uppercase">Archivos</span>
        {canEdit && (
          <>
            <IconButton icon="filePlus" size="xs" label="Nuevo archivo" onClick={onNewFile} />
            <IconButton icon="upload" size="xs" label="Subir archivos" onClick={onPickFiles} disabled={uploading} />
          </>
        )}
        <IconButton icon="panelLeft" size="xs" label="Ocultar archivos" onClick={onHide} />
      </div>
      <div className="px-2.5 pb-2">
        <button
          type="button"
          onClick={onSearch}
          className="flex h-[34px] w-full items-center gap-2 rounded-md border border-border bg-surface pr-2 pl-2.5 text-[13px] text-muted hover:border-border-input"
        >
          <Icon name="search" size={15} />
          <span className="flex-1 text-left">Buscar archivo</span>
          <kbd className="rounded border border-border px-1.5 font-mono text-[11px]">{MOD_KEY} P</kbd>
        </button>
      </div>
      <ul
        role="tree"
        aria-label="Árbol de archivos"
        className={`m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-auto px-1.5 pb-2 ${dropTarget === '' ? 'bg-accent-soft/40' : ''}`}
      >
        {renderNodes(nodes, 0)}
        {nodes.length === 0 && <li className="px-2 py-3 text-[13px] text-muted">El proyecto no tiene archivos.</li>}
      </ul>
      {canEdit && (
        <p role="status" className="m-2.5 mt-0 flex items-start gap-2 rounded-lg border border-dashed border-border p-2.5 text-[12.5px] leading-snug text-muted">
          <Icon name={uploading ? 'spinner' : 'upload'} size={15} className={`mt-px ${uploading ? 'animate-spin' : ''}`} />
          {uploading
            ? 'Subiendo…'
            : dropTarget !== null
              ? `Soltá para subir a ${dropTarget ? `${dropTarget}/` : 'la raíz'}.`
              : 'Arrastrá archivos al árbol o a una carpeta para subirlos.'}
        </p>
      )}
    </nav>
  );
}

interface FileItemProps {
  node: FileNode;
  level: number;
  active: boolean;
  main: boolean;
  canEdit: boolean;
  url: string;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onSetMain: () => void;
}

function FileItem({ node, level, active, main, canEdit, url, onOpen, onRename, onDelete, onSetMain }: FileItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState<{ top: number; left: number } | null>(null);
  const image = isImage(node.path);
  const items: MenuItem[] = [
    { label: 'Abrir', icon: 'file', shortcut: 'Enter', onSelect: onOpen },
    ...(canEdit ? [{ label: 'Renombrar o mover', icon: 'pencil' as const, shortcut: 'F2', onSelect: onRename }] : []),
    ...(canEdit && /\.tex$/i.test(node.path) && !main ? [{ label: 'Usar como principal', icon: 'star' as const, onSelect: onSetMain }] : []),
    { label: 'Descargar', icon: 'download', onSelect: () => download(url) },
    ...(canEdit ? [{ label: 'Borrar', icon: 'trash' as const, shortcut: 'Supr', danger: true, separated: true, onSelect: onDelete }] : []),
  ];

  // Posición fija: el árbol tiene scroll y recortaría una vista previa absoluta.
  const showPreview = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setPreview({ top: Math.min(rect.top, window.innerHeight - 200), left: rect.right + 8 });
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    setMenuOpen(true);
  };

  return (
    <li role="treeitem" aria-selected={active} className="group relative" onContextMenu={onContextMenu}>
      <button
        type="button"
        title={node.path}
        onClick={onOpen}
        onMouseEnter={(event) => image && showPreview(event.currentTarget)}
        onMouseLeave={() => setPreview(null)}
        onFocus={(event) => image && showPreview(event.currentTarget)}
        onBlur={() => setPreview(null)}
        onKeyDown={(event) => {
          if (event.key === 'Delete' && canEdit) onDelete();
          if (event.key === 'F2' && canEdit) onRename();
        }}
        style={{ paddingLeft: 6 + level * 16 + 20 }}
        className={`flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-md pr-8 text-left text-[13.5px] ${
          active ? 'bg-accent-soft font-semibold text-accent-text' : 'text-text hover:bg-surface-2'
        }`}
      >
        <Icon name={fileIcon(node.path)} size={16} className={active ? 'text-accent-text' : 'text-faint'} />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {main && (
          <span title="Documento principal" className="text-warning">
            <Icon name="star" size={14} filled />
            <span className="sr-only">(documento principal)</span>
          </span>
        )}
      </button>
      <div className={`absolute top-[3px] right-1 ${menuOpen ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          width={230}
          items={items}
          trigger={(triggerProps) => (
            <button
              type="button"
              aria-label={`Acciones de ${node.name}`}
              className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-text"
              {...triggerProps}
            >
              <Icon name="more" size={16} strokeWidth={2.6} />
            </button>
          )}
        />
      </div>
      {preview && (
        <div style={preview} className="pointer-events-none fixed z-30 flex w-[232px] flex-col gap-2 rounded-[10px] border border-border bg-surface p-2 shadow-pop">
          <div className="flex h-[140px] items-center justify-center overflow-hidden rounded-md border border-border bg-white">
            <img src={url} alt="" className="max-h-full max-w-full object-contain" />
          </div>
          <div className="flex justify-between gap-2 px-1 pb-0.5 text-[12.5px]">
            <span className="truncate font-semibold">{node.name}</span>
            <span className="flex-none text-muted">{formatBytes(node.file.size)}</span>
          </div>
        </div>
      )}
    </li>
  );
}
