import nodemailer from 'nodemailer';
import type { AssignableRole } from '@latexweb/shared';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}
export interface InvitationMessage {
  to: string;
  projectName: string;
  role: AssignableRole;
  url: string;
  expiresAt: Date;
}
export interface InvitationEmail {
  publicUrl: string;
  send(message: InvitationMessage): Promise<void>;
}

/** STARTTLS obligatorio cuando secure=false; nunca degradar a SMTP sin cifrar. */
export function createInvitationEmail(config: MailConfig, publicUrl: string): InvitationEmail {
  const transport = nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.secure, requireTLS: !config.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return {
    publicUrl,
    async send(message) {
      const result = await transport.sendMail({
        from: { address: config.from, name: 'Pliego' }, to: { address: message.to, name: '' },
        subject: 'Invitación para colaborar en Pliego',
        text: `Te invitaron al proyecto «${message.projectName}» como ${message.role === 'editor' ? 'editor' : 'lector'}.\n\n`
          + `Acepta entrando con la cuenta de Google ${message.to}:\n${message.url}\n\n`
          + `Vence: ${message.expiresAt.toISOString()}. El enlace solo puede aceptarse una vez y con ese correo verificado.\n`
          + 'Si no esperabas esta invitación, puedes ignorarla.',
      });
      if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP no aceptó el destinatario');
    },
  };
}
