// Logotipo: una hoja con la esquina doblada y el nombre en Newsreader cursiva.
/** Nombre del producto. El diseño propone Pliego; si queda latexweb, se cambia solo acá y en index.html. */
export const PRODUCT_NAME = 'Pliego';

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="flex-none">
      <path d="M7 4h13l6 6v18H7z" className="fill-accent" />
      <path d="M20 4l6 6h-6z" className="fill-brand-2" />
      <path d="M11.5 16h9M11.5 21h6" className="stroke-on-accent" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <LogoMark size={size} />
      <span className="font-serif leading-none font-medium italic" style={{ fontSize: size }}>
        {PRODUCT_NAME.toLowerCase()}
      </span>
    </span>
  );
}
