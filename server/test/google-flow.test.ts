import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { googleHash, type GoogleProvider, type GoogleStateStore, type GoogleTransaction } from '../src/features/auth/google';
import type { AuthService } from '../src/features/auth/service';

const user = { id: '123', email: 'ana@example.com', name: 'Ana', createdAt: new Date(0).toISOString(), privacy: null };
const session = { user, token: 'new-session', expiresAt: new Date(Date.now() + 86_400_000) };
const identity = { subject: 'google-123', email: user.email, name: 'Ana' };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function harness() {
  let clock = 0;
  const stored = new Map<string, { transaction: GoogleTransaction; expires: number }>();
  const states: GoogleStateStore = {
    async put(state, transaction) { stored.set(state, { transaction, expires: clock + 600_000 }); },
    async consume(state, hash) {
      const row = stored.get(state);
      if (!row || row.expires <= clock || row.transaction.browserHash !== hash) return null;
      stored.delete(state);
      return row.transaction;
    },
  };
  const exchange = vi.fn<GoogleProvider['exchange']>().mockResolvedValue(identity);
  const provider: GoogleProvider = {
    authorizationUrl: (state, nonce, challenge) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ state, nonce, code_challenge: challenge })}`,
    exchange,
  };
  const loginWithGoogle = vi.fn<AuthService['loginWithGoogle']>().mockResolvedValue(session);
  const logout = vi.fn<AuthService['logout']>().mockResolvedValue(undefined);
  const auth: AuthService = {
    acceptPrivacy: vi.fn(), register: vi.fn(), login: vi.fn(), loginWithGoogle, logout,
    getUserBySessionToken: async (token) => token === 'old-session' ? user : null,
    sweepExpiredSessions: async () => 0,
  };
  const app = await buildApp({ auth: { service: auth, cookieSecure: true,
    google: { provider, states, cookieSecret: 'test-secret-with-at-least-32-bytes' } } });
  apps.push(app);
  const start = async (query = '', cookie?: string) => {
    const response = await app.inject({ url: `/api/auth/google${query}`, headers: cookie ? { cookie } : {} });
    const location = new URL(String(response.headers.location));
    const state = location.searchParams.get('state')!;
    const flowCookie = String(response.headers['set-cookie']).split(';')[0]!;
    return { response, location, state, cookie: flowCookie, flow: stored.get(state)?.transaction };
  };
  const callback = (state: string, cookie: string, query = 'code=google-code') =>
    app.inject({ url: `/api/auth/google/callback?state=${state}&${query}`, headers: { cookie } });
  return { app, start, callback, stored, exchange, loginWithGoogle, logout, expire: () => { clock = 600_001; } };
}

describe('flujo HTTP de Google', () => {
  it('usa state, nonce, PKCE y cookie firmada; rota la sesión y vuelve solo a un destino interno', async () => {
    const h = await harness();
    expect((await h.app.inject('/api/auth/providers')).json()).toEqual({ google: true, emailInvitations: false });
    const flow = await h.start('?volver=%2Fproyectos%2Fabc');
    expect(flow.response.statusCode).toBe(302);
    expect(flow.response.cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(flow.location.searchParams.get('code_challenge')).toBe(googleHash(flow.flow!.verifier));
    const result = await h.callback(flow.state, flow.cookie + '; sid=old-session');
    expect(h.exchange).toHaveBeenCalledWith('google-code', flow.flow!.verifier, flow.flow!.nonce);
    expect(h.loginWithGoogle).toHaveBeenCalledWith(identity, undefined);
    expect(h.logout).toHaveBeenCalledWith('old-session');
    expect(result.headers.location).toBe('/proyectos/abc');
    expect(result.cookies.find((c) => c.name === 'sid')).toMatchObject({ httpOnly: true, secure: true });
    expect(result.headers['cache-control']).toContain('no-store');
    expect((await h.callback(flow.state, flow.cookie)).headers.location).toContain('google_expired');
    expect(h.exchange).toHaveBeenCalledTimes(1);
  });

  it('rechaza state ajeno, cookie manipulada, navegador diferente y transacciones vencidas', async () => {
    const h = await harness();
    const a = await h.start('?volver=https%3A%2F%2Fevil.example');
    expect(a.flow!.returnPath).toBe('/');
    const b = await h.start();
    for (const [state, cookie] of [[a.state, b.cookie], [a.state, a.cookie + 'x'], ['x'.repeat(43), a.cookie]]) {
      expect((await h.callback(state!, cookie!)).headers.location).toContain('google_expired');
    }
    h.expire();
    expect((await h.callback(a.state, a.cookie)).headers.location).toContain('google_expired');
    expect(h.exchange).not.toHaveBeenCalled();
    expect(h.loginWithGoogle).not.toHaveBeenCalled();
  });

  it('la cancelación consume state; los errores del proveedor no filtran secretos ni crean sesiones', async () => {
    const h = await harness();
    const cancelled = await h.start();
    expect((await h.callback(cancelled.state, cancelled.cookie, 'error=access_denied')).headers.location).toContain('google_cancelled');
    expect((await h.callback(cancelled.state, cancelled.cookie)).headers.location).toContain('google_expired');
    h.exchange.mockRejectedValue(new Error('client_secret=VERY-PRIVATE&code=SECRET-CODE'));
    const flow = await h.start();
    const result = await h.callback(flow.state, flow.cookie);
    expect(result.headers.location).toContain('google_failed');
    expect(JSON.stringify(result.headers) + result.body).not.toMatch(/VERY-PRIVATE|SECRET-CODE/);
    expect(result.cookies.some((c) => c.name === 'sid')).toBe(false);
    expect(h.loginWithGoogle).not.toHaveBeenCalled();
  });

  it('vincular exige una sesión válida al inicio y al retorno', async () => {
    const h = await harness();
    expect((await h.app.inject('/api/auth/google?link=1')).headers.location).toContain('google_link_required');
    const invalid = await h.start('?link=1', 'sid=old-session');
    expect((await h.callback(invalid.state, invalid.cookie)).headers.location).toContain('google_expired');
    expect(h.exchange).not.toHaveBeenCalled();
    const flow = await h.start('?link=1', 'sid=old-session');
    await h.callback(flow.state, flow.cookie + '; sid=old-session');
    expect(h.loginWithGoogle).toHaveBeenCalledWith(identity, user.id);
  });

  it('sin configuración, conserva el login local y no anuncia Google', async () => {
    const app = await buildApp({ auth: { service: {
      acceptPrivacy: vi.fn(), register: vi.fn(), login: vi.fn(), loginWithGoogle: vi.fn(), logout: vi.fn(),
      getUserBySessionToken: async () => null, sweepExpiredSessions: async () => 0,
    }, cookieSecure: false } });
    apps.push(app);
    expect((await app.inject('/api/auth/providers')).json()).toEqual({ google: false, emailInvitations: false });
    expect((await app.inject('/api/auth/google')).headers.location).toContain('google_unavailable');
  });
});
