import type { ButtonHTMLAttributes } from 'react';

/** Logo oficial local; sin SDK ni peticiones a terceros para dibujar el botón. */
export function GoogleButton({ children = 'Continuar con Google', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2.5 rounded border border-[#747775] bg-white px-3 py-2.5 text-sm font-medium text-[#1f1f1f] transition-shadow hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 ${className}`}>
      <img src="/brand/google-g.png" alt="" aria-hidden="true" width={20} height={20} className="size-5 flex-none" />
      <span>{children}</span>
    </button>
  );
}
