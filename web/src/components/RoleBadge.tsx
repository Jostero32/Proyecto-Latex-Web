// Rol con ícono y palabra: nunca solo el color.
import type { ProjectRole } from '@latexweb/shared';
import { Icon, type IconName } from './Icon';

export const ROLE_LABELS: Record<ProjectRole, string> = { owner: 'Dueño', editor: 'Editor', viewer: 'Lector' };
export const ROLE_ICONS: Record<ProjectRole, IconName> = { owner: 'crown', editor: 'pencil', viewer: 'eye' };

export function RoleBadge({ role }: { role: ProjectRole }) {
  return (
    <span className="inline-flex h-[26px] w-fit items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-[13px] font-medium whitespace-nowrap">
      <Icon name={ROLE_ICONS[role]} size={14} strokeWidth={1.9} />
      {ROLE_LABELS[role]}
    </span>
  );
}
