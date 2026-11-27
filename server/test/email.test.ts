import nodemailer from 'nodemailer';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { createInvitationEmail } from '../src/features/sharing/email';

afterEach(() => vi.restoreAllMocks());
const env = {
  GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'private', SESSION_SECRET: 'secret-with-at-least-thirty-two-bytes',
  PUBLIC_URL: 'https://pliego.duckdns.org', COOKIE_SECURE: 'true',
  SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587', SMTP_SSL: 'false',
  SMTP_USER: 'pliego@gmail.com', SMTP_PASSWORD: 'test-app-password', SMTP_FROM: 'pliego@gmail.com',
};
it('valida SMTP y exige STARTTLS para 587, sin enviar mensajes reales', async () => {
  const config = loadConfig(env).mail!;
  expect(config.publicUrl).toBe(env.PUBLIC_URL);
  expect(() => loadConfig({ ...env, SMTP_PASSWORD: '' })).toThrow('SMTP');
  expect(() => loadConfig({ ...env, SMTP_FROM: 'a@gmail.com\r\nBcc: b@gmail.com' })).toThrow('SMTP');
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const send = vi.spyOn(transport, 'sendMail');
  const factory = vi.spyOn(nodemailer, 'createTransport').mockReturnValue(transport);
  const email = createInvitationEmail(config.smtp, config.publicUrl);
  expect(factory).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true, disableFileAccess: true, disableUrlAccess: true }));
  send.mockResolvedValue({ accepted: ['guest@gmail.com'], rejected: [], envelope: { from: '', to: [] }, messageId: 'test' } as never);
  const message = { to: 'guest@gmail.com', projectName: 'Tesis', role: 'viewer' as const,
    url: 'https://pliego.duckdns.org/unirse/test-token', expiresAt: new Date(0) };
  await email.send(message);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: { address: 'guest@gmail.com', name: '' }, text: expect.stringContaining(message.url) }));
  send.mockResolvedValue({ accepted: [], rejected: ['guest@gmail.com'] } as never);
  await expect(email.send(message)).rejects.toThrow('SMTP');
});
