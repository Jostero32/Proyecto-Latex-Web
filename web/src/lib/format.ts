// Formatos de fecha, tamaño y duración en español.
const LOCALE = 'es-AR';

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "hace 12 minutos", "ayer", "hace 2 semanas". */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'recién';
}

const dateFormat = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });

/** "17 nov 2026". */
export function shortDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

const decimal = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

/** "312 KB", "4,2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${decimal.format(bytes / (1024 * 1024))} MB`;
}

/** "2,4 s". */
export function formatSeconds(ms: number): string {
  return `${decimal.format(ms / 1000)} s`;
}

/** Ctrl en Windows y Linux, ⌘ en Mac. */
export const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
