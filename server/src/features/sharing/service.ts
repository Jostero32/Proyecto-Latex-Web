// Miembros, enlaces anteriores e invitaciones por correo verificado. Solo el dueño administra.
import { createHash, randomBytes } from 'node:crypto';
import {
  ASSIGNABLE_ROLES,
  isUuid,
  type AssignableRole,
  type CreatedShareLink,
  type JoinResponse,
  type ProjectMember,
  type ShareLink,
  type SharePreview,
} from '@latexweb/shared';
import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import type { Db } from '../../db';
import { ApiError } from '../../http';
import { projectMembers, projects, shareLinks, users } from '../../schema';
import { normalizeEmail } from '../auth/passwords';
import type { InvitationEmail } from './email';
import type { ProjectDocs } from '../collab/documents';
import { higherRole } from '../projects/service';

const MAX_LINK_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export const hashShareToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function checkAssignableRole(raw: unknown): AssignableRole {
  if (!(ASSIGNABLE_ROLES as readonly unknown[]).includes(raw)) {
    throw new ApiError(400, 'invalid_request', `Rol inválido; opciones: ${ASSIGNABLE_ROLES.join(', ')}`);
  }
  return raw as AssignableRole;
}

const toLink = (row: typeof shareLinks.$inferSelect): ShareLink => ({
  id: row.id,
  role: row.role,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
  recipientEmail: row.recipientEmail,
});

export interface SharingService {
  members(projectId: string): Promise<ProjectMember[]>;
  setRole(projectId: string, userId: string, role: unknown): Promise<ProjectMember>;
  removeMember(projectId: string, userId: string): Promise<void>;
  createLink(projectId: string, createdBy: string, role: unknown, expiresInDays: unknown): Promise<CreatedShareLink>;
  invite(projectId: string, createdBy: string, email: unknown, role: unknown, days: unknown): Promise<ShareLink>;
  links(projectId: string): Promise<ShareLink[]>;
  revokeLink(projectId: string, linkId: string): Promise<void>;
  /** Qué proyecto y rol da el enlace, sin unirse. */
  preview(userId: string, token: string): Promise<SharePreview>;
  /** Si ya era miembro, se queda con el rol más alto. */
  join(userId: string, token: string): Promise<JoinResponse>;
}

export function createSharingService(db: Db, docs: ProjectDocs, email?: InvitationEmail): SharingService {
  async function member(projectId: string, userId: string): Promise<ProjectMember> {
    const [row] = isUuid(userId)
      ? await db
          .select({ userId: users.id, email: users.email, name: users.name, role: projectMembers.role })
          .from(projectMembers)
          .innerJoin(users, eq(users.id, projectMembers.userId))
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      : [];
    if (!row) throw new ApiError(404, 'not_found', 'No es miembro del proyecto');
    return row;
  }

  /** El enlace vigente del token, o 404 `invalid_link` (no existe, venció o fue revocado). */
  async function validLink(token: string) {
    const [link] = await db
      .select()
      .from(shareLinks)
      .where(and(eq(shareLinks.tokenHash, hashShareToken(token)), isNull(shareLinks.revokedAt)));
    if (!link || link.acceptedAt || (link.expiresAt && link.expiresAt <= new Date())) {
      throw new ApiError(404, 'invalid_link', 'El enlace no existe, venció o fue revocado');
    }
    return link;
  }

  async function checkRecipient(link: typeof shareLinks.$inferSelect, userId: string, query: Pick<Db, 'select'> = db) {
    if (!link.recipientEmail) return;
    const [user] = await query.select().from(users).where(eq(users.id, userId));
    if (!user || user.email !== link.recipientEmail) {
      throw new ApiError(403, 'invitation_email_mismatch', 'Esta invitación corresponde a otra cuenta. Entra con el correo invitado.');
    }
    if (!user.googleSubject || user.googleEmail !== link.recipientEmail) {
      throw new ApiError(403, 'google_verification_required', 'Vincula la cuenta de Google de este correo para verificar tu identidad.');
    }
  }

  async function changeableMember(projectId: string, userId: string): Promise<ProjectMember> {
    const target = await member(projectId, userId);
    if (target.role === 'owner') throw new ApiError(400, 'cannot_change_owner', 'El rol del dueño no se puede cambiar');
    return target;
  }

  return {
    async members(projectId) {
      return db
        .select({ userId: users.id, email: users.email, name: users.name, role: projectMembers.role })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(eq(projectMembers.projectId, projectId))
        .orderBy(asc(projectMembers.createdAt));
    },

    async setRole(projectId, userId, rawRole) {
      const role = checkAssignableRole(rawRole);
      const target = await changeableMember(projectId, userId);
      await db
        .update(projectMembers)
        .set({ role })
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, target.userId)));
      // Sus conexiones se reconectan con el rol nuevo (de lector, en solo lectura).
      if (role !== target.role) docs.disconnect(projectId, target.userId);
      return { ...target, role };
    },

    async removeMember(projectId, userId) {
      const target = await changeableMember(projectId, userId);
      await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, target.userId)));
      docs.disconnect(projectId, target.userId);
    },

    async createLink(projectId, createdBy, rawRole, rawDays) {
      const role = checkAssignableRole(rawRole);
      let expiresAt: Date | null = null;
      if (rawDays !== undefined && rawDays !== null) {
        if (typeof rawDays !== 'number' || !Number.isInteger(rawDays) || rawDays < 1 || rawDays > MAX_LINK_DAYS) {
          throw new ApiError(400, 'invalid_request', `expiresInDays tiene que ser un entero entre 1 y ${MAX_LINK_DAYS}`);
        }
        expiresAt = new Date(Date.now() + rawDays * DAY_MS);
      }
      const token = randomBytes(32).toString('base64url');
      const [row] = await db
        .insert(shareLinks)
        .values({ projectId, tokenHash: hashShareToken(token), role, createdBy, expiresAt })
        .returning();
      if (!row) throw new Error('no se creó el enlace');
      return { ...toLink(row), token };
    },

    async invite(projectId, createdBy, rawEmail, rawRole, rawDays) {
      if (!email) throw new ApiError(503, 'email_unavailable', 'El envío de invitaciones no está configurado');
      const recipientEmail = normalizeEmail(rawEmail);
      if (!recipientEmail || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(recipientEmail)) {
        throw new ApiError(400, 'invalid_request', 'Introduce una dirección de correo válida');
      }
      const role = checkAssignableRole(rawRole);
      const days = rawDays ?? 7;
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_LINK_DAYS) {
        throw new ApiError(400, 'invalid_request', 'El vencimiento debe estar entre 1 y 365 días');
      }
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
      if (!project) throw new ApiError(404, 'not_found', 'El proyecto no existe');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + days * DAY_MS);
      const [row] = await db.insert(shareLinks).values({
        projectId, createdBy, role, expiresAt, recipientEmail, tokenHash: hashShareToken(token),
        // Inactiva hasta que SMTP confirme el envío; un fallo o reinicio no deja un token usable.
        revokedAt: new Date(),
      }).returning();
      if (!row) throw new Error('No se creó la invitación');
      try {
        await email.send({ to: recipientEmail, projectName: project.name, role, expiresAt,
          url: `${email.publicUrl}/unirse/${encodeURIComponent(token)}` });
        await db.update(shareLinks).set({ revokedAt: null }).where(eq(shareLinks.id, row.id));
      } catch {
        throw new ApiError(503, 'email_delivery_failed', 'No se pudo enviar el correo. La invitación quedó invalidada; puedes reintentar.');
      }
      return toLink(row);
    },

    async links(projectId) {
      const rows = await db
        .select()
        .from(shareLinks)
        .where(
          and(
            eq(shareLinks.projectId, projectId),
            isNull(shareLinks.revokedAt),
            isNull(shareLinks.acceptedAt),
            or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, new Date())),
          ),
        )
        .orderBy(asc(shareLinks.createdAt));
      return rows.map(toLink);
    },

    async revokeLink(projectId, linkId) {
      const [row] = isUuid(linkId)
        ? await db
            .update(shareLinks)
            .set({ revokedAt: new Date() })
            .where(and(eq(shareLinks.projectId, projectId), eq(shareLinks.id, linkId), isNull(shareLinks.revokedAt)))
            .returning({ id: shareLinks.id })
        : [];
      if (!row) throw new ApiError(404, 'not_found', 'El enlace no existe');
    },

    async preview(userId, token) {
      const link = await validLink(token);
      await checkRecipient(link, userId);
      const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, link.projectId));
      const [owner] = await db
        .select({ name: users.name })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(and(eq(projectMembers.projectId, link.projectId), eq(projectMembers.role, 'owner')));
      const [mine] = await db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, link.projectId), eq(projectMembers.userId, userId)));
      // Del dueño, solo el nombre: el email no se muestra a quien todavía no es miembro.
      return { projectId: link.projectId, projectName: project?.name ?? '', ownerName: owner?.name ?? null, role: link.role, currentRole: mine?.role ?? null };
    },

    async join(userId, token) {
      return db.transaction(async (tx) => {
        const [link] = await tx.select().from(shareLinks).where(eq(shareLinks.tokenHash, hashShareToken(token))).for('update');
        if (!link || link.revokedAt || link.acceptedAt || (link.expiresAt && link.expiresAt <= new Date())) {
          throw new ApiError(404, 'invalid_link', 'El enlace no existe, venció, fue usado o revocado');
        }
        await checkRecipient(link, userId, tx);
        if (link.recipientEmail) await tx.update(shareLinks).set({ acceptedAt: new Date() }).where(eq(shareLinks.id, link.id));
        const [current] = await tx
          .select({ role: projectMembers.role })
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, link.projectId), eq(projectMembers.userId, userId)))
          .for('update');
        if (!current) {
          await tx.insert(projectMembers).values({ projectId: link.projectId, userId, role: link.role }).onConflictDoNothing();
          return { projectId: link.projectId, role: link.role };
        }
        const role = higherRole(current.role, link.role);
        if (role !== current.role) {
          await tx
            .update(projectMembers)
            .set({ role })
            .where(and(eq(projectMembers.projectId, link.projectId), eq(projectMembers.userId, userId)));
        }
        return { projectId: link.projectId, role };
      });
    },
  };
}
