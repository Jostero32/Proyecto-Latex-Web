// Avisos: ícono y palabra juntos, con el tono del estado. `role="alert"` solo para lo que interrumpe.
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type Tone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

const TONES: Record<Tone, { box: string; icon: IconName; iconColor: string }> = {
  info: { box: 'bg-accent-soft', icon: 'info', iconColor: 'text-accent-text' },
  success: { box: 'bg-success-soft', icon: 'check', iconColor: 'text-success' },
  warning: { box: 'bg-warning-soft', icon: 'warning', iconColor: 'text-warning' },
  error: { box: 'bg-error-soft', icon: 'error', iconColor: 'text-error' },
  neutral: { box: 'bg-surface-2', icon: 'info', iconColor: 'text-muted' },
};

interface NoticeProps {
  tone: Tone;
  title: string;
  children?: ReactNode;
  icon?: IconName;
  /** Acciones a la derecha o debajo. */
  actions?: ReactNode;
  alert?: boolean;
  className?: string;
}

export function Notice({ tone, title, children, icon, actions, alert = false, className = '' }: NoticeProps) {
  const style = TONES[tone];
  return (
    <div role={alert ? 'alert' : 'status'} className={`flex items-start gap-2.5 rounded-lg px-3.5 py-3 text-sm leading-snug ${style.box} ${className}`}>
      <Icon name={icon ?? style.icon} size={18} strokeWidth={1.9} className={`mt-px ${style.iconColor}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className={`font-semibold ${style.iconColor}`}>{title}</strong>
        {children && <span className="text-text">{children}</span>}
        {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Chip de estado (resultado de compilar, conteos): ícono, texto y fondo suave del tono. */
export function StatusChip({ tone, icon, children, spin = false }: { tone: Tone; icon?: IconName; children: ReactNode; spin?: boolean }) {
  const style = TONES[tone];
  return (
    <span role="status" className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-semibold whitespace-nowrap ${style.box} ${style.iconColor}`}>
      <Icon name={icon ?? style.icon} size={14} strokeWidth={2} className={spin ? 'animate-spin' : ''} />
      {children}
    </span>
  );
}
