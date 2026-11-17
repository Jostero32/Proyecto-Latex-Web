// Avatares de presencia: color por persona (asignado por orden de llegada) y el nombre siempre al lado,
// en el tooltip y para el lector de pantalla.

/** Colores de colaboración; el texto blanco pasa 4,5:1 sobre cada uno. */
export const COLLABORATOR_COLORS = ['#3D52C9', '#C2410C', '#0F766E', '#9333EA', '#B45309', '#BE185D'] as const;

export function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const words = source.split(/[\s.@_-]+/).filter(Boolean);
  const letters = words.length > 1 && name ? `${words[0]![0]}${words[1]![0]}` : (words[0]?.[0] ?? '?');
  return letters.toUpperCase();
}

interface AvatarProps {
  name: string | null;
  email: string;
  color: string;
  size?: number;
  /** Tooltip y texto accesible; por defecto, el nombre. */
  title?: string;
  /** Aro del color de fondo, para apilarlos. */
  ring?: boolean;
}

export function Avatar({ name, email, color, size = 30, title, ring = false }: AvatarProps) {
  const label = title ?? name ?? email;
  return (
    <span
      title={label}
      className={`relative inline-flex flex-none items-center justify-center rounded-full font-semibold text-white ${ring ? 'ring-2 ring-bg' : ''}`}
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.38) }}
    >
      <span aria-hidden="true">{initials(name, email)}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export interface Presence {
  name: string | null;
  email: string;
  color: string;
  /** Archivo abierto, para el tooltip. */
  file?: string;
  you?: boolean;
}

/** Pila de avatares: vos primero; más de `max` se resumen en +N. */
export function AvatarStack({ people, max = 4 }: { people: Presence[]; max?: number }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <ul aria-label="En el proyecto ahora" className="m-0 flex list-none items-center p-0">
      {shown.map((person, index) => (
        <li key={person.email} className={index ? '-ml-1.5' : ''} style={{ zIndex: 10 - index }}>
          <Avatar
            name={person.name}
            email={person.email}
            color={person.color}
            ring
            title={person.you ? `Vos (${person.name ?? person.email})` : `${person.name ?? person.email}${person.file ? `, en ${person.file}` : ''}`}
          />
        </li>
      ))}
      {rest > 0 && (
        <li className="-ml-1.5">
          <span className="inline-flex size-[30px] items-center justify-center rounded-full bg-surface-2 text-[11.5px] font-semibold text-text ring-2 ring-bg">
            +{rest}
            <span className="sr-only"> personas más</span>
          </span>
        </li>
      )}
    </ul>
  );
}
