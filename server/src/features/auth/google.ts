import { createHash, randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client, type TokenPayload } from 'google-auth-library';
import type { Redis } from 'ioredis';
import { normalizeEmail } from './passwords';
import type { GoogleIdentity } from './service';

export const GOOGLE_FLOW_SECONDS = 600;
export const GOOGLE_CALLBACK = '/api/auth/google/callback';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  cookieSecret: string;
}

export interface GoogleTransaction {
  browserHash: string;
  verifier: string;
  nonce: string;
  returnPath: string;
  linkUserId?: string;
}

export interface GoogleStateStore {
  put(state: string, transaction: GoogleTransaction): Promise<void>;
  consume(state: string, browserHash: string): Promise<GoogleTransaction | null>;
}

export interface GoogleProvider {
  authorizationUrl(state: string, nonce: string, challenge: string): string;
  exchange(code: string, verifier: string, nonce: string): Promise<GoogleIdentity>;
}

export interface GoogleAuthDeps {
  provider: GoogleProvider;
  states: GoogleStateStore;
  cookieSecret: string;
}

export const googleRandom = () => randomBytes(32).toString('base64url');
export const googleHash = (value: string) => createHash('sha256').update(value).digest('base64url');

/** El ID token ya debe tener firma, emisor, audiencia y caducidad verificados por la biblioteca. */
export function googleIdentity(payload: TokenPayload | undefined, nonce: string, clientId: string): GoogleIdentity {
  const email = normalizeEmail(payload?.email);
  if (!payload || payload.nonce !== nonce || payload.email_verified !== true || !email
    || !/^[\x21-\x7e]{1,255}$/.test(payload.sub ?? '') || (payload.azp && payload.azp !== clientId)) {
    throw new Error('Identidad de Google inválida');
  }
  return { subject: payload.sub, email, ...(typeof payload.name === 'string' ? { name: payload.name } : {}) };
}

export function createGoogleProvider(config: GoogleConfig): GoogleProvider {
  // Un cliente por intercambio: no se comparten credenciales de usuarios entre peticiones.
  const client = () => new OAuth2Client({
    clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri,
    transporterOptions: { timeout: 10_000, retry: false },
  });
  return {
    authorizationUrl: (state, nonce, challenge) => client().generateAuthUrl({
      scope: ['openid', 'email', 'profile'], access_type: 'online', prompt: 'select_account',
      state, nonce, code_challenge: challenge, code_challenge_method: CodeChallengeMethod.S256,
    }),
    async exchange(code, verifier, nonce) {
      const oauth = client();
      const { tokens } = await oauth.getToken({ code, codeVerifier: verifier });
      if (!tokens.id_token) throw new Error('Falta el ID token de Google');
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
      return googleIdentity(ticket.getPayload(), nonce, config.clientId);
    },
  };
}

const TAKE_STATE = `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
if cjson.decode(value).browserHash ~= ARGV[1] then return nil end
redis.call('DEL', KEYS[1])
return value
`;

/** Consumo atómico, compartido entre instancias; si Redis falla no se autentica al usuario. */
export function createRedisGoogleStates(redis: Redis): GoogleStateStore {
  const key = (state: string) => `latexweb-google:${googleHash(state)}`;
  return {
    async put(state, transaction) {
      const saved = await redis.set(key(state), JSON.stringify(transaction), 'EX', GOOGLE_FLOW_SECONDS, 'NX');
      if (saved !== 'OK') throw new Error('No se pudo iniciar OAuth');
    },
    async consume(state, browserHash) {
      const value = await redis.eval(TAKE_STATE, 1, key(state), browserHash);
      return typeof value === 'string' ? JSON.parse(value) as GoogleTransaction : null;
    },
  };
}

/** Destino interno, sin controles ni separadores de host codificados. */
export function googleReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/')
    || value.startsWith('//') || /[\\\p{Cc}]|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c|2f)/iu.test(value)) return '/';
  const parsed = new URL(value, 'https://pliego.invalid');
  return parsed.origin === 'https://pliego.invalid' ? parsed.pathname + parsed.search + parsed.hash : '/';
}
