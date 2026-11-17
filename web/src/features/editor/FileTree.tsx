// Árbol de archivos: carpetas plegables, ícono por tipo, estrella en el documento principal, vista previa
// de imágenes al pasar el mouse y menú por archivo (también con clic derecho). Los lectores solo abren y
// descargan. Arrastrar archivos marca la carpeta destino (la subida llega en el paso 3).
import { useState, type DragEvent, type MouseEvent } from 'react';
import { IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Menu, type MenuItem } from '../../components/Menu';
import { formatBytes, MOD_KEY } from '../../lib/format';
import { fileIcon, isImage, type FileNode, type TreeNode } from './tree';

interface FileTreeProps {
  nodes: TreeNode[];
  activePath: string | null;
  mainFile: string;
  canEdit: boolean;
  onOpen: (path: string) => void;
  onHide: () => void;
  onSearch: () => void;
  onNewFile: () => void;
  onDelete: (path: string) => void;
  onSetMain: (path: string) => void;
}

export function FileTree({ nodes, activePath, mainFile, canEdit, onOpen, onHide, onSearch, onNewFile, onDelete, onSetMain }: FileTreeProps) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set(['capitulos/metodologia']));
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
          {dropTarget === node.path && (
            <span className="ml-8 block text-[12px] font-semibold text-accent-text">Soltá para subir a {node.path}/</span>
          )}
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
          onOpen={() => onOpen(node.path)}
          onDelete={() => onDelete(node.path)}
          onSetMain={() => onSetMain(node.path)}
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
        setDropTarget(null);
      }}
    >
      <div className="flex h-11 flex-none items-center gap-0.5 pr-1.5 pl-3.5">
        <span className="flex-1 text-xs font-semibold tracking-wider text-muted uppercase">Archivos</span>
        {canEdit && (
          <>
            <IconButton icon="filePlus" size="xs" label="Nuevo archivo" onClick={onNewFile} />
            <IconButton icon="upload" size="xs" label="Subir archivos" />
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
      </ul>
      {canEdit && (
        <p className="m-2.5 mt-0 flex items-start gap-2 rounded-lg border border-dashed border-border p-2.5 text-[12.5px] leading-snug text-muted">
          <Icon name="upload" size={15} className="mt-px" />
          {dropTarget !== null ? `Soltá para subir a ${dropTarget ? `${dropTarget}/` : 'la raíz'}.` : 'Arrastrá archivos al árbol o a una carpeta para subirlos.'}
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
  onOpen: () => void;
  onDelete: () => void;
  onSetMain: () => void;
}

function FileItem({ node, level, active, main, canEdit, onOpen, onDelete, onSetMain }: FileItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState<{ top: number; left: number } | null>(null);
  const image = isImage(node.path);
  const items: MenuItem[] = [
    { label: 'Abrir', icon: 'file', shortcut: 'Enter', onSelect: onOpen },
    ...(canEdit ? [{ label: 'Renombrar o mover', icon: 'pencil' as const, shortcut: 'F2' }] : []),
    ...(canEdit && node.path.endsWith('.tex') && !main ? [{ label: 'Usar como principal', icon: 'star' as const, onSelect: onSetMain }] : []),
    { label: 'Descargar', icon: 'download' },
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
          trigger={(props) => (
            <button
              type="button"
              aria-label={`Acciones de ${node.name}`}
              className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-text"
              {...props}
            >
              <Icon name="more" size={16} strokeWidth={2.6} />
            </button>
          )}
        />
      </div>
      {preview && (
        <div style={preview} className="fixed z-30 flex w-[232px] flex-col gap-2 rounded-[10px] border border-border bg-surface p-2 shadow-pop">
          <ImagePlaceholder className="h-[140px]" />
          <div className="flex justify-between gap-2 px-1 pb-0.5 text-[12.5px]">
            <span className="truncate font-semibold">{node.name}</span>
            <span className="flex-none text-muted">{formatBytes(node.file.size)}</span>
          </div>
        </div>
      )}
    </li>
  );
}

/** Imagen de muestra (paso 1): el árbol todavía no baja las imágenes reales. */
export function ImagePlaceholder({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center rounded-md border border-border bg-white ${className}`}>
      <svg width="150" height="100" viewBox="0 0 150 100" aria-hidden="true">
        <path d="M10 85 Q40 30 75 55 T140 25" fill="none" stroke="#2F45C6" strokeWidth="2" />
        <path d="M10 85 Q50 60 80 70 T140 60" fill="none" stroke="#0F766E" strokeWidth="2" strokeDasharray="4 3" />
        <circle cx="40" cy="48" r="5" fill="#C2410C" />
        <circle cx="96" cy="58" r="5" fill="#C2410C" />
        <circle cx="124" cy="34" r="5" fill="#C2410C" />
        <path d="M10 90h130M10 10v80" stroke="#8F8B82" strokeWidth="1" />
      </svg>
    </div>
  );
}
