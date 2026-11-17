// Barra superior del editor (52 px): volver, nombre (el dueño lo renombra ahí mismo), conexión,
// presencia, Compartir (solo el dueño) y el menú del proyecto.
import { useState } from 'react';
import { Link } from 'react-router';
import type { ProjectRole } from '@latexweb/shared';
import { AvatarStack, type Presence } from '../../components/Avatar';
import { Button, IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { LogoMark } from '../../components/Logo';
import { Menu, type MenuItem } from '../../components/Menu';
import { RoleBadge } from '../../components/RoleBadge';
import { AccountMenu } from '../../components/AccountMenu';

export type Connection = 'guardado' | 'sincronizando' | 'sin-conexion';

interface TopBarProps {
  name: string;
  role: ProjectRole;
  connection: Connection;
  presence: Presence[];
  onRename: (name: string) => void;
  onShare: () => void;
  onSettings: () => void;
  onDelete: () => void;
  onDownload: () => void;
}

export function TopBar({ name, role, connection, presence, onRename, onShare, onSettings, onDelete, onDownload }: TopBarProps) {
  const [editing, setEditing] = useState(false);
  const owner = role === 'owner';
  const menu: MenuItem[] = [
    { label: 'Descargar como zip', icon: 'download', onSelect: onDownload },
    ...(role !== 'viewer' ? [{ label: 'Ajustes del proyecto', icon: 'settings' as const, onSelect: onSettings }] : []),
    ...(owner ? [{ label: 'Borrar proyecto…', icon: 'trash' as const, danger: true, separated: true, onSelect: onDelete }] : []),
  ];

  return (
    <header className="flex h-[52px] flex-none items-center gap-2 border-b border-border bg-bg pr-3 pl-2">
      <Link to="/" aria-label="Volver a mis proyectos" title="Volver a mis proyectos" className="flex size-10 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text">
        <Icon name="back" />
      </Link>
      <LogoMark size={22} />
      {owner && editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get('name');
            if (typeof value === 'string' && value.trim()) onRename(value.trim());
            setEditing(false);
          }}
        >
          <input
            name="name"
            aria-label="Nombre del proyecto"
            defaultValue={name}
            autoFocus
            maxLength={120}
            onBlur={(event) => event.currentTarget.form?.requestSubmit()}
            onKeyDown={(event) => event.key === 'Escape' && setEditing(false)}
            className="h-9 w-[380px] max-w-[40vw] rounded-md border-[1.5px] border-accent bg-surface px-2 text-[15px] font-semibold text-text"
          />
        </form>
      ) : owner ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Renombrar proyecto"
          aria-label={`${name}. Renombrar proyecto`}
          className="group flex h-9 max-w-[380px] min-w-0 items-center gap-2 rounded-md px-2 text-[15px] font-semibold hover:bg-surface-2"
        >
          <span className="truncate">{name}</span>
          <Icon name="pencil" size={14} className="text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
      ) : (
        <>
          <span className="max-w-[380px] truncate px-2 text-[15px] font-semibold">{name}</span>
          <RoleBadge role={role} />
        </>
      )}
      <ConnectionStatus connection={connection} />
      <span className="flex-1" />
      <AvatarStack people={presence} />
      {owner && (
        <Button size="sm" icon="share" onClick={onShare} className="ml-1 h-9">
          Compartir
        </Button>
      )}
      <Menu items={menu} trigger={(props) => <IconButton icon="more" label="Menú del proyecto" {...props} />} />
      <AccountMenu compact />
    </header>
  );
}

function ConnectionStatus({ connection }: { connection: Connection }) {
  if (connection === 'sin-conexion') {
    return (
      <span role="status" className="flex h-7 items-center gap-1.5 rounded-full bg-warning-soft px-2.5 text-[13px] font-semibold whitespace-nowrap text-warning">
        <Icon name="cloudOff" size={15} />
        Sin conexión, reintentando
      </span>
    );
  }
  const syncing = connection === 'sincronizando';
  return (
    <span role="status" className="flex items-center gap-1.5 px-1 text-[13px] whitespace-nowrap text-muted">
      <Icon name={syncing ? 'sync' : 'check'} size={15} className={syncing ? 'animate-spin [animation-duration:1.4s]' : 'text-success'} />
      {syncing ? 'Sincronizando…' : 'Guardado'}
    </span>
  );
}
