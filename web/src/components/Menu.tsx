// Menú desplegable: botón con aria-expanded y una lista que se cierra con Esc, al elegir o al hacer clic
// afuera. Flechas arriba y abajo recorren las opciones. La lista tiene posición fija (calculada desde el
// botón) para que un panel con scroll no la recorte; se cierra si la página se desplaza.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  danger?: boolean;
  shortcut?: string;
  /** Marca la opción elegida (p. ej. el tema actual). */
  checked?: boolean;
  /** Línea separadora antes de esta opción. */
  separated?: boolean;
}

interface MenuProps {
  items: MenuItem[];
  /** Dibuja el botón que abre el menú. */
  trigger: (props: { 'aria-expanded': boolean; 'aria-haspopup': 'menu'; onClick: () => void }) => ReactNode;
  align?: 'left' | 'right';
  width?: number;
  /** Título opcional arriba de las opciones. */
  heading?: ReactNode;
  /** Abrir desde afuera (menú contextual). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Menu({ items, trigger, align = 'right', width = 220, heading, open: controlled, onOpenChange }: MenuProps) {
  const [internal, setInternal] = useState(false);
  const open = controlled ?? internal;
  const setOpen = (value: boolean) => {
    setInternal(value);
    onOpenChange?.(value);
  };
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ opacity: 0 });

  useLayoutEffect(() => {
    if (!open || !root.current || !list.current) return;
    const anchor = root.current.getBoundingClientRect();
    const height = list.current.offsetHeight;
    const left = Math.max(8, Math.min(align === 'right' ? anchor.right - width : anchor.left, window.innerWidth - width - 8));
    const below = anchor.bottom + 6 + height <= window.innerHeight - 8;
    setPosition({ left, top: below ? anchor.bottom + 6 : Math.max(8, anchor.top - 6 - height) });
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>('[role^=menuitem]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (!list.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      setPosition({ opacity: 0 });
    };
    // setOpen cambia en cada render; solo importa abrir o cerrar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      {trigger({ 'aria-expanded': open, 'aria-haspopup': 'menu', onClick: () => setOpen(!open) })}
      {open && (
        <div
          ref={list}
          role="menu"
          style={{ width, ...position }}
          className="fixed z-50 flex flex-col rounded-[10px] border border-border bg-surface p-1.5 text-text shadow-pop"
        >
          {heading && <div className="px-2.5 pt-1.5 pb-2 text-[13px] text-muted">{heading}</div>}
          {items.map((item) => (
            <div key={item.label} className="contents">
              {item.separated && <span role="separator" className="mx-1 my-1.5 h-px bg-border" />}
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
                className={`flex h-10 items-center gap-2.5 rounded-md px-2.5 text-left text-sm hover:bg-surface-2 focus-visible:bg-surface-2 ${
                  item.danger ? 'text-error' : ''
                }`}
              >
                {item.icon && <Icon name={item.icon} size={16} />}
                <span className="flex-1">{item.label}</span>
                {item.checked && <Icon name="check" size={16} className="text-accent-text" />}
                {item.shortcut && <kbd className="font-mono text-[11px] text-muted">{item.shortcut}</kbd>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
