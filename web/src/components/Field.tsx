// Campo de texto con etiqueta, ayuda y error. El error se anuncia y no depende solo del color.
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Icon } from './Icon';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Texto gris al lado de la etiqueta, p. ej. "(opcional)". */
  labelNote?: string;
  hint?: ReactNode;
  error?: string | null;
  /** Marca el campo sin mensaje propio (el error se explica en un aviso arriba). */
  invalid?: boolean;
  /** Algo dentro del campo, a la derecha (p. ej. Mostrar contraseña). */
  trailing?: ReactNode;
}

export function TextField({ label, labelNote, hint, error, invalid = false, trailing, className = '', ...rest }: TextFieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-semibold">
        {label} {labelNote && <span className="font-normal text-muted">{labelNote}</span>}
      </label>
      <div className="relative">
        <input
          id={id}
          aria-invalid={error || invalid ? true : undefined}
          aria-describedby={describedBy}
          className={`h-11 w-full rounded-md border-[1.5px] bg-surface px-3 text-[15px] text-text placeholder:text-muted ${
            error || invalid ? 'border-error' : 'border-border-input'
          } ${trailing ? 'pr-24' : ''}`}
          {...rest}
        />
        {trailing && <div className="absolute top-1 right-1">{trailing}</div>}
      </div>
      {error && (
        <span id={`${id}-error`} className="flex items-center gap-1.5 text-[13px] text-error">
          <Icon name="error" size={14} strokeWidth={2} />
          {error}
        </span>
      )}
      {hint && (
        <span id={`${id}-hint`} className="text-[13px] text-muted">
          {hint}
        </span>
      )}
    </div>
  );
}

const SELECT_CLASS = 'h-11 w-full rounded-md border-[1.5px] border-border-input bg-surface px-3 text-[15px] text-text';

export function SelectField({
  label,
  hint,
  children,
  ...rest
}: { label: string; hint?: ReactNode; children: ReactNode } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <select id={id} className={SELECT_CLASS} aria-describedby={hint ? `${id}-hint` : undefined} {...rest}>
        {children}
      </select>
      {hint && (
        <span id={`${id}-hint`} className="text-[13px] text-muted">
          {hint}
        </span>
      )}
    </div>
  );
}
