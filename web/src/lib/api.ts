// Cliente de la API: mismo origen (Vite reenvía /api), con la cookie de sesión. Un error de la API llega
// como ApiRequestError con el código estable de `{ error }`, para decidir el mensaje en la interfaz.

export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Segundos de `Retry-After` (429 y 503), si vino. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Cuerpo JSON. */
  json?: unknown;
  /** Cuerpo multipart (subidas). */
  form?: FormData;
  signal?: AbortSignal;
}

async function send(url: string, { method = 'GET', json, form, signal }: RequestOptions): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: json === undefined ? undefined : { 'content-type': 'application/json' },
      body: json === undefined ? form : JSON.stringify(json),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(0, 'network_error', 'No pudimos conectarnos. Revisá tu conexión.');
  }
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  const retry = Number(response.headers.get('retry-after'));
  throw new ApiRequestError(
    response.status,
    typeof body?.error === 'string' ? body.error : 'http_error',
    typeof body?.message === 'string' ? body.message : `Error ${response.status}`,
    Number.isFinite(retry) && retry > 0 ? retry : null,
  );
}

/** Petición con respuesta JSON (o sin cuerpo, en un 204). */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(`/api${path}`, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Respuesta cruda de una ruta completa de la API (`/api/compilations/…/pdf`): PDF, log o SyncTeX. */
export function fetchApi(url: string, signal?: AbortSignal): Promise<Response> {
  return send(url, { signal });
}

export const isApiError = (error: unknown, code?: string): error is ApiRequestError =>
  error instanceof ApiRequestError && (code === undefined || error.code === code);

/** Mensaje para mostrar de cualquier error (el de la API ya viene en español). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Algo salió mal. Reintentá en un momento.';
}

/** Descarga un archivo de la API; `filename` cambia el nombre que propone el server. */
export function download(url: string, filename = ''): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
}
