// Lectura validada de variables de entorno para los config.ts de las apps. TS puro: recibe el
// entorno como objeto (no usa process.env), así que web también puede importar el paquete.

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Entero positivo; una variable ausente o vacía usa `fallback`. */
export function envPositiveInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`${name} debe ser un entero positivo: "${raw}"`);
  return value;
}

/** Número positivo (admite decimales). */
export function envPositiveNumber(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} debe ser un número positivo: "${raw}"`);
  return value;
}

/** Tamaño con el formato de Docker: `256m`, `1g`, `512k`. */
export function envSize(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*[kmg]$/.test(raw)) throw new ConfigError(`${name} debe tener la forma 256m o 1g: "${raw}"`);
  return raw;
}
