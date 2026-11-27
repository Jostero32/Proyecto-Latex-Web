import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginTicket, OAuth2Client, type GetTokenOptions, type Credentials, type VerifyIdTokenOptions, type TokenPayload } from 'google-auth-library';
import { loadConfig } from '../src/config';
import { createGoogleProvider, googleIdentity, googleReturnPath } from '../src/features/auth/google';

afterEach(() => vi.restoreAllMocks());
const payload: TokenPayload = {
  iss: 'https://accounts.google.com', aud: 'client.apps.googleusercontent.com',
  sub: 'google-123', iat: 1, exp: 9999999999, email: 'Ana@Example.com', email_verified: true, nonce: 'nonce',
};
const env = {
  GOOGLE_CLIENT_ID: payload.aud, GOOGLE_CLIENT_SECRET: 'server-only-secret',
  SESSION_SECRET: 'test-session-secret-longer-than-32-bytes', PUBLIC_URL: 'https://pliego.duckdns.org', COOKIE_SECURE: 'true',
};

describe('Google OIDC y configuración', () => {
  it('deriva el callback canónico de PUBLIC_URL y rechaza configuración parcial o insegura', () => {
    expect(loadConfig(env).google?.redirectUri).toBe('https://pliego.duckdns.org/api/auth/google/callback');
    expect(loadConfig({}).google).toBeUndefined();
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: 'id' })).toThrow('Google requiere');
    expect(() => loadConfig({ ...env, SESSION_SECRET: 'short' })).toThrow('Google requiere');
    expect(() => loadConfig({ ...env, PUBLIC_URL: 'http://pliego.duckdns.org' })).toThrow('HTTPS');
    expect(() => loadConfig({ ...env, PUBLIC_URL: 'https://pliego.duckdns.org/otra-ruta' })).toThrow('PUBLIC_URL');
    expect(() => loadConfig({ ...env, COOKIE_SECURE: 'false' })).toThrow('COOKIE_SECURE');
  });

  it('exige nonce, email verificado y sujeto estable incluso después de verificar el JWT', () => {
    expect(googleIdentity(payload, 'nonce', payload.aud)).toEqual({ subject: 'google-123', email: 'ana@example.com' });
    for (const invalid of [
      { ...payload, nonce: 'otro' }, { ...payload, email_verified: false },
      { ...payload, sub: '' }, { ...payload, email: undefined }, { ...payload, azp: 'otro-cliente' },
    ]) expect(() => googleIdentity(invalid, 'nonce', payload.aud)).toThrow('Identidad');
  });

  it('envía PKCE al intercambio y delega la validación de firma y audiencia en la biblioteca oficial', async () => {
    const provider = createGoogleProvider(loadConfig(env).google!);
    const url = new URL(provider.authorizationUrl('state', 'nonce', 'challenge'));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe('https://pliego.duckdns.org/api/auth/google/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.toString()).not.toContain(env.GOOGLE_CLIENT_SECRET);
    const prototype = OAuth2Client.prototype as unknown as {
      getToken(options: GetTokenOptions): Promise<{ tokens: Credentials; res: null }>;
      verifyIdToken(options: VerifyIdTokenOptions): Promise<LoginTicket>;
    };
    const getToken = vi.spyOn(prototype, 'getToken').mockResolvedValue({ tokens: { id_token: 'signed-token' }, res: null });
    const verify = vi.spyOn(prototype, 'verifyIdToken').mockResolvedValue(new LoginTicket('', payload));
    expect(await provider.exchange('code', 'verifier', 'nonce')).toMatchObject({ subject: payload.sub });
    expect(getToken).toHaveBeenCalledWith({ code: 'code', codeVerifier: 'verifier' });
    expect(verify).toHaveBeenCalledWith({ idToken: 'signed-token', audience: payload.aud });
    verify.mockRejectedValue(new Error('firma, audiencia, emisor o caducidad inválidos'));
    await expect(provider.exchange('code', 'verifier', 'nonce')).rejects.toThrow('inválidos');
  });

  it('el destino de retorno no puede sacar al navegador de Pliego', () => {
    expect(googleReturnPath('/proyectos/abc?tab=pdf')).toBe('/proyectos/abc?tab=pdf');
    for (const path of ['https://evil.example', '//evil.example', '/\\evil.example', '/%2f%2fevil.example', '/\nevil.example']) {
      expect(googleReturnPath(path)).toBe('/');
    }
  });
});
