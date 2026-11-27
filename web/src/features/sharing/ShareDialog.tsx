// Compartir (solo el dueño): miembros e invitaciones por correo verificadas con Google.
import { useState } from 'react';
import type { AssignableRole, ProjectMember, ShareLink } from '@latexweb/shared';
import { Avatar, colorFor } from '../../components/Avatar';
import { Button, IconButton } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { ROLE_ICONS, ROLE_LABELS } from '../../components/RoleBadge';
import { errorMessage } from '../../lib/api';
import { shortDate } from '../../lib/format';
import { useAuthProviders } from '../auth/api';
import { useInvite, useMembers, useRemoveMember, useRevokeShareLink, useSetMemberRole, useShareLinks } from './api';

const EXPIRY_OPTIONS = [
  { value: '1', label: 'En 1 día' },
  { value: '7', label: 'En 7 días' },
  { value: '30', label: 'En 30 días' },
  { value: '365', label: 'En 365 días' },
  { value: 'otro', label: 'Otra cantidad…' },
];

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
}

export function ShareDialog({ open, onClose, projectId, projectName }: ShareDialogProps) {
  const members = useMembers(projectId, open);
  const links = useShareLinks(projectId, open);
  const setRole = useSetMemberRole(projectId);
  const removeMember = useRemoveMember(projectId);
  const createLink = useInvite(projectId);
  const providers = useAuthProviders();
  const revokeLink = useRevokeShareLink(projectId);
  const [created, setCreated] = useState<ShareLink | null>(null);
  const [newId, setNewId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const [revoking, setRevoking] = useState<ShareLink | null>(null);
  const failed = [setRole, removeMember, createLink, revokeLink].find((m) => m.isError);

  const create = (email: string, role: AssignableRole, days: number) =>
    createLink.mutate(
      { email, role, expiresInDays: days },
      {
        onSuccess: (link) => {
          setCreated(link);
          setNewId(link.id);
        },
      },
    );

  const close = () => {
    setCreated(null);
    onClose();
  };

  return (
    <>
      <Dialog open={open} onClose={close} title="Compartir" subtitle={projectName} width="lg">
        {failed?.isError && (
          <Notice tone="error" alert title="No se pudo hacer el cambio">
            {errorMessage(failed.error)}
          </Notice>
        )}
        <section aria-labelledby="share-members" className="flex flex-col gap-2.5">
          <h3 id="share-members" className="m-0 text-sm font-semibold">
            Miembros{members.data ? ` · ${members.data.length}` : ''}
          </h3>
          {members.isPending && <ListPlaceholder rows={2} />}
          {members.isError && <ListFailed text="No pudimos cargar los miembros." onRetry={() => void members.refetch()} />}
          {members.data && (
            <ul className="m-0 flex list-none flex-col rounded-xl border border-border p-0">
              {members.data.map((member, index) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  color={colorFor(member.userId)}
                  first={index === 0}
                  onRole={(role) => setRole.mutate({ userId: member.userId, role })}
                  onRemove={() => setRemoving(member)}
                />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="share-links" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 id="share-links" className="m-0 text-sm font-semibold">
              Invitaciones por correo
            </h3>
            <p className="m-0 text-[13.5px] leading-normal text-muted">
              Solo el correo invitado, verificado con Google, puede aceptar. El enlace vence y se usa una sola vez.
            </p>
          </div>
          {created ? <CreatedPanel link={created} onDone={() => setCreated(null)} /> : providers.data?.emailInvitations
            ? <LinkForm pending={createLink.isPending} onCreate={create} />
            : <Notice tone="info" title="Envío no disponible">El administrador debe configurar Google y el correo de invitaciones.</Notice>}
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-semibold text-muted">Enlaces vigentes{links.data ? ` · ${links.data.length}` : ''}</span>
            {links.isPending && <ListPlaceholder rows={1} />}
            {links.isError && <ListFailed text="No pudimos cargar los enlaces." onRetry={() => void links.refetch()} />}
            {links.data?.length === 0 && (
              <p className="m-0 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted">No hay enlaces vigentes.</p>
            )}
            {links.data && links.data.length > 0 && (
              <ul className="m-0 flex list-none flex-col rounded-xl border border-border p-0">
                {[...links.data].reverse().map((link, index) => (
                  <li
                    key={link.id}
                    className={`grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 pr-2 pl-3.5 sm:grid-cols-[96px_minmax(0,1fr)_auto_auto] ${
                      index ? 'border-t border-border' : ''
                    }`}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      <Icon name={ROLE_ICONS[link.role]} size={15} />
                      {ROLE_LABELS[link.role]}
                    </span>
                    <span className="flex min-w-0 flex-col text-[13px] text-muted">
                      <span className="truncate" title={link.recipientEmail ?? undefined}>{link.recipientEmail ?? 'Enlace libre (anterior)'}</span>
                      <span>Creado el {shortDate(link.createdAt)}</span>
                      <span>{link.expiresAt ? `Vence el ${shortDate(link.expiresAt)}` : 'Sin vencimiento'}</span>
                    </span>
                    {link.id === newId ? (
                      <span className="hidden rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-text sm:inline">Nuevo</span>
                    ) : (
                      <span className="hidden sm:inline" />
                    )}
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      aria-label={`Revocar enlace de ${ROLE_LABELS[link.role].toLowerCase()} creado el ${shortDate(link.createdAt)}`}
                      onClick={() => setRevoking(link)}
                    >
                      Revocar
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && removeMember.mutate(removing.userId)}
        title={`¿Quitar a ${removing?.name ?? removing?.email ?? ''}?`}
        confirmLabel="Quitar del proyecto"
      >
        Deja de ver el proyecto en el momento. Si lo tiene abierto, se le cierra.
      </ConfirmDialog>
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (!revoking) return;
          revokeLink.mutate(revoking.id);
          if (revoking.id === created?.id) setCreated(null);
        }}
        title="¿Revocar el enlace?"
        confirmLabel="Revocar enlace"
      >
        Nadie más va a poder unirse con ese enlace. Quienes ya se unieron siguen siendo miembros.
      </ConfirmDialog>
    </>
  );
}

function ListPlaceholder({ rows }: { rows: number }) {
  return (
    <div aria-busy="true" className="flex flex-col rounded-xl border border-border">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={`flex h-14 items-center gap-3 px-3 ${index ? 'border-t border-border' : ''}`}>
          <span className="size-[34px] animate-pulse rounded-full bg-surface-2" />
          <span className="h-3 w-40 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

function ListFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-sm">
      <span className="flex items-center gap-2 text-error">
        <Icon name="error" size={16} />
        {text}
      </span>
      <Button size="sm" icon="sync" onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}

interface MemberRowProps {
  member: ProjectMember;
  color: string;
  first: boolean;
  onRole: (role: AssignableRole) => void;
  onRemove: () => void;
}

function MemberRow({ member, color, first, onRole, onRemove }: MemberRowProps) {
  const title = member.name ?? member.email;
  return (
    <li className={`flex items-center gap-3 py-2.5 pr-2 pl-3 ${first ? '' : 'border-t border-border'}`}>
      <Avatar name={member.name} email={member.email} color={color} size={34} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{title}</span>
        <span title={member.email} className="truncate text-[13px] text-muted">
          {member.name ? member.email : 'Sin nombre'}
        </span>
      </div>
      {member.role === 'owner' ? (
        <span title="Al dueño no se lo puede cambiar ni quitar" className="flex items-center gap-1.5 pr-3 text-sm font-semibold text-muted">
          <Icon name="crown" size={15} />
          Dueño
        </span>
      ) : (
        <>
          <select
            aria-label={`Rol de ${title}`}
            value={member.role}
            onChange={(event) => onRole(event.target.value as AssignableRole)}
            className="h-9 rounded-md border-[1.5px] border-border-input bg-surface px-2 text-sm text-text"
          >
            <option value="editor">Editor</option>
            <option value="viewer">Lector</option>
          </select>
          <IconButton icon="x" size="sm" label={`Quitar a ${title} del proyecto`} onClick={onRemove} />
        </>
      )}
    </li>
  );
}

function LinkForm({ pending, onCreate }: { pending: boolean; onCreate: (email: string, role: AssignableRole, days: number) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('editor');
  const [expiry, setExpiry] = useState('7');
  const [days, setDays] = useState('45');
  const custom = expiry === 'otro';
  const parsed = Number(days);
  const badDays = custom && !(Number.isInteger(parsed) && parsed >= 1 && parsed <= 365);
  const chosenDays = custom ? parsed : Number(expiry);
  const validEmail = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email.trim());

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-bg p-3.5">
      <div className="flex w-full flex-col gap-1.5">
        <label htmlFor="invite-email" className="text-[13px] font-semibold">Correo de la cuenta Google invitada</label>
        <input id="invite-email" type="email" autoComplete="email" maxLength={254} value={email}
          onChange={(event) => setEmail(event.target.value)} placeholder="persona@gmail.com"
          className="h-10 rounded-md border-[1.5px] border-border-input bg-surface px-3 text-sm text-text" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span id="link-role" className="text-[13px] font-semibold">
          Rol
        </span>
        <div role="group" aria-labelledby="link-role" className="flex gap-0.5 rounded-lg bg-surface-2 p-[3px]">
          {(['editor', 'viewer'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={role === value}
              onClick={() => setRole(value)}
              className={`flex h-[34px] items-center gap-1.5 rounded-md px-3 text-sm font-semibold ${role === value ? 'bg-surface text-text shadow-sm' : 'text-muted'}`}
            >
              <Icon name={ROLE_ICONS[value]} size={15} />
              {ROLE_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="link-expiry" className="text-[13px] font-semibold">
          Vence
        </label>
        <select
          id="link-expiry"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          className="h-10 rounded-md border-[1.5px] border-border-input bg-surface px-2 text-sm text-text"
        >
          {EXPIRY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {custom && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="link-days" className="text-[13px] font-semibold">
            Días
          </label>
          <input
            id="link-days"
            type="number"
            min={1}
            max={365}
            value={days}
            aria-invalid={badDays || undefined}
            aria-describedby="link-days-help"
            onChange={(event) => setDays(event.target.value)}
            className={`h-10 w-24 rounded-md border-[1.5px] bg-surface px-2 text-sm text-text ${badDays ? 'border-error' : 'border-border-input'}`}
          />
        </div>
      )}
      <span className="flex-1" />
      <Button variant="primary" icon="link" disabled={!validEmail || badDays || pending} onClick={() => onCreate(email.trim(), role, chosenDays)} className="h-10">
        {pending ? 'Enviando…' : 'Enviar invitación'}
      </Button>
      {custom && (
        <span id="link-days-help" className={`w-full text-[13px] ${badDays ? 'text-error' : 'text-muted'}`}>
          Entre 1 y 365 días.
        </span>
      )}
    </div>
  );
}

function CreatedPanel({ link, onDone }: { link: ShareLink; onDone: () => void }) {
  return (
    <Notice tone="success" title="Invitación enviada" actions={<Button size="sm" onClick={onDone}>Invitar a otra persona</Button>}>
      Enviamos la invitación a <strong>{link.recipientEmail}</strong>. Solo esa cuenta verificada con Google puede aceptarla.
      {' '}{ROLE_LABELS[link.role]} · Vence el {shortDate(link.expiresAt!)}.
    </Notice>
  );
}
