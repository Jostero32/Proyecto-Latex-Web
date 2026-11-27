// Configuración de server. Único lugar donde se lee process.env (ver CLAUDE.md).
import { ConfigError, envPositiveInteger, type Env } from '@latexweb/shared';
import { GOOGLE_CALLBACK, type GoogleConfig } from './features/auth/google';
import type { CompileConfig } from './features/compile/service';
import type { ProjectLimits } from './features/files/service';
import { DEFAULT_ALLOWED_HOSTS, DEFAULT_ALLOWED_ORIGINS, type RequestGuardOptions } from './http';
import type { MailConfig } from './features/sharing/email';
import type { StorageConfig } from './storage';

export { ConfigError } from '@latexweb/shared';

export interface ServerConfig {
  host: string;
  port: number;
  redisUrl: string;
  databaseUrl: string;
  /** Cookie de sesión con el atributo Secure (obligatorio en producción, con HTTPS). */
  cookieSecure: boolean;
  /** Timeout para recibir una petición completa (contra subidas lentas tipo slowloris). */
  requestTimeoutMs: number;
  security: RequestGuardOptions;
  /** MinIO (S3): binarios de los proyectos. */
  storage: StorageConfig;
  projects: ProjectLimits;
  compile: CompileConfig;
  /** Swagger UI en /api/docs (API_DOCS=false lo apaga). */
  apiDocs: boolean;
  google?: GoogleConfig;
  mail?: { smtp: MailConfig; publicUrl: string };
}

const MB = 1024 * 1024;

export function loadConfig(env: Env = process.env): ServerConfig {
  const google = googleConfig(env);
  const mail = mailConfig(env, google);
  return {
    // Por defecto solo localhost. En docker compose es 0.0.0.0 dentro del contenedor, y compose lo
    // publica solo en 127.0.0.1 del host (ver docs/specs/docker-compose.md).
    host: env.SERVER_HOST === undefined || env.SERVER_HOST === '' ? '127.0.0.1' : env.SERVER_HOST,
    port: envPositiveInteger(env, 'SERVER_PORT', 53000),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:56379',
    databaseUrl: env.DATABASE_URL ?? 'postgresql://latexweb:latexweb@127.0.0.1:55432/latexweb',
    cookieSecure: env.COOKIE_SECURE === 'true',
    requestTimeoutMs: envPositiveInteger(env, 'SERVER_REQUEST_TIMEOUT_MS', 120_000),
    security: {
      allowedOrigins: list(env.ALLOWED_ORIGINS) ?? DEFAULT_ALLOWED_ORIGINS,
      allowedHosts: list(env.ALLOWED_HOSTS) ?? DEFAULT_ALLOWED_HOSTS,
    },
    storage: {
      endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:59000',
      region: env.S3_REGION ?? 'us-east-1',
      accessKey: env.S3_ACCESS_KEY ?? 'latexweb',
      secretKey: env.S3_SECRET_KEY ?? 'latexweb-dev-secret',
      bucket: env.S3_BUCKET ?? 'latexweb',
    },
    projects: {
      maxBytes: envPositiveInteger(env, 'PROJECT_MAX_BYTES', 200 * MB),
      maxFiles: envPositiveInteger(env, 'PROJECT_MAX_FILES', 500),
      fileMaxBytes: envPositiveInteger(env, 'FILE_MAX_BYTES', 50 * MB),
      docMaxBytes: envPositiveInteger(env, 'DOC_MAX_BYTES', 10 * MB),
    },
    compile: {
      maxQueued: envPositiveInteger(env, 'COMPILE_MAX_QUEUED', 50),
      // Igual que la regla del bucket, que borra las compilaciones a 1 día.
      ttlSeconds: envPositiveInteger(env, 'COMPILE_TTL_SECONDS', 24 * 60 * 60),
    },
    apiDocs: env.API_DOCS !== 'false',
    ...(google ? { google } : {}),
    ...(mail ? { mail } : {}),
  };
}

function googleConfig(env: Env): GoogleConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return undefined;
  const cookieSecret = env.SESSION_SECRET;
  if (!clientId || !clientSecret || !cookieSecret || Buffer.byteLength(cookieSecret) < 32 || !env.PUBLIC_URL) {
    throw new ConfigError('Google requiere GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET (32 bytes como mínimo) y PUBLIC_URL');
  }
  let url: URL;
  try { url = new URL(env.PUBLIC_URL); } catch { throw new ConfigError('PUBLIC_URL debe ser una URL válida'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') throw new ConfigError('PUBLIC_URL debe ser un origen HTTPS, sin ruta ni credenciales (HTTP solo para localhost)');
  if (url.protocol === 'https:' && env.COOKIE_SECURE !== 'true') throw new ConfigError('Google sobre HTTPS requiere COOKIE_SECURE=true');
  return { clientId, clientSecret, cookieSecret, redirectUri: url.origin + GOOGLE_CALLBACK };
}

/** Lista separada por comas; ausente o vacía → undefined (se usa el valor por defecto). */
function list(raw: string | undefined): string[] | undefined {
  const items = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function mailConfig(env: Env, google: GoogleConfig | undefined): ServerConfig['mail'] {
  if (!env.SMTP_HOST && !env.SMTP_USER && !env.SMTP_PASSWORD && !env.SMTP_FROM) return undefined;
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASSWORD: password, SMTP_FROM: from } = env;
  if (!host || !user || !password || !from || !google) {
    throw new ConfigError('Invitaciones requieren Google configurado y SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_FROM');
  }
  if (/[\r\n]/.test(host + user + from) || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(from)) {
    throw new ConfigError('SMTP_FROM debe ser una dirección de correo y SMTP no admite saltos de línea');
  }
  if (env.SMTP_SSL && !['true', 'false'].includes(env.SMTP_SSL)) throw new ConfigError('SMTP_SSL debe ser true o false');
  const port = envPositiveInteger(env, 'SMTP_PORT', env.SMTP_SSL === 'true' ? 465 : 587);
  if (port > 65535) throw new ConfigError('SMTP_PORT fuera de rango');
  return { smtp: { host, port, secure: env.SMTP_SSL === 'true', user, password, from }, publicUrl: new URL(google.redirectUri).origin };
}
