// Botones del sistema: radio de 6 px, alto de 44 px (táctil) o compactos en barras de herramientas.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
type Size = 'lg' | 'md' | 'sm';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-110 disabled:bg-surface-2 disabled:text-muted disabled:hover:brightness-100',
  secondary: 'border-[1.5px] border-border-input bg-surface text-text hover:bg-surface-2 disabled:text-muted',
  ghost: 'text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50',
  danger: 'bg-error text-on-accent hover:brightness-110 disabled:bg-surface-2 disabled:text-muted',
  'danger-ghost': 'text-error hover:bg-error-soft',
};

const SIZES: Record<Size, string> = {
  lg: 'h-12 px-5 text-[15px]',
  md: 'h-11 px-4 text-sm',
  sm: 'h-8 px-2.5 text-[13px]',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  children: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', icon, className = '', children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Obligatorio: es lo que anuncia el lector de pantalla y el tooltip. */
  label: string;
  size?: 'md' | 'sm' | 'xs';
  pressed?: boolean;
}

const ICON_SIZES = { md: 'size-10', sm: 'size-9', xs: 'size-8' } as const;

export function IconButton({ icon, label, size = 'md', pressed, className = '', type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`inline-flex flex-none items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        pressed ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-surface-2 hover:text-text'
      } ${ICON_SIZES[size]} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={size === 'xs' ? 16 : 18} />
    </button>
  );
}
