// Diálogo modal con <dialog>: el navegador atrapa el foco, cierra con Esc y lo devuelve al control que
// lo abrió. El foco inicial va al elemento con `data-autofocus` (en las confirmaciones, Cancelar):
// `autoFocus` no sirve, porque React enfoca antes de que showModal() mueva el foco al primer botón.
import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './Button';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Línea debajo del título (p. ej. el nombre del proyecto). */
  subtitle?: string;
  width?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  /** Botones de abajo, alineados a la derecha. */
  footer?: ReactNode;
}

const WIDTHS = { sm: 'max-w-[460px]', md: 'max-w-[520px]', lg: 'max-w-[640px]' } as const;

export function Dialog({ open, onClose, title, subtitle, width = 'sm', children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        // Clic en el fondo (fuera del contenido) cierra.
        if (event.target === ref.current) onClose();
      }}
      aria-labelledby="dialog-title"
      className={`m-auto mt-[8vh] max-h-[84vh] w-[calc(100%-32px)] ${WIDTHS[width]} rounded-[14px] border border-border bg-surface p-0 text-text shadow-pop`}
    >
      {open && (
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id="dialog-title" className="m-0 font-serif text-[26px] leading-tight font-medium">
                {title}
              </h2>
              {subtitle && <p className="m-0 truncate text-sm text-muted">{subtitle}</p>}
            </div>
            <IconButton icon="x" label="Cerrar" onClick={onClose} className="-mr-2 -mt-1" />
          </div>
          {children}
          {footer && <div className="flex flex-wrap justify-end gap-2.5">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
