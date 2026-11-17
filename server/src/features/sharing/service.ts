// Miembros y enlaces para compartir. Lo administra el dueño; unirse con un enlace, cualquiera con sesión.
import { createHash, randomBytes } from 'node:crypto';
import {
  ASSIGNABLE_ROLES,
  isUuid,
  type AssignableRole,
  type CreatedShareLink,
  type JoinResponse,
  type ProjectMember,
  type ShareLink,
} from '@latexweb/shared';
import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import type { Db } from '../../db';
import { ApiError } from '../../http';
import { projectMembers, shareLinks, users } from '../../schema';
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
});

export interface SharingService {
  members(projectId: string): Promise<ProjectMember[]>;
  setRole(projectId: string, userId: string, role: unknown): Promise<ProjectMember>;
  removeMember(projectId: string, userId: string): Promise<void>;
  createLink(projectId: string, createdBy: string, role: unknown, expiresInDays: unknown): Promise<CreatedShareLink>;
  links(projectId: string): Promise<ShareLink[]>;
  revokeLink(projectId: string, linkId: string): Promise<void>;
  /** Si ya era miembro, se queda con el rol más alto. */
  join(userId: string, token: string): Promise<JoinResponse>;
}

export function createSharingService(db: Db): SharingService {
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
      return { ...target, role };
    },

    async removeMember(projectId, userId) {
      const target = await changeableMember(projectId, userId);
      await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, target.userId)));
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

    async links(projectId) {
      const rows = await db
        .select()
        .from(shareLinks)
        .where(
          and(
            eq(shareLinks.projectId, projectId),
            isNull(shareLinks.revokedAt),
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

    async join(userId, token) {
      const [link] = await db
        .select()
        .from(shareLinks)
        .where(and(eq(shareLinks.tokenHash, hashShareToken(token)), isNull(shareLinks.revokedAt)));
      if (!link || (link.expiresAt && link.expiresAt <= new Date())) {
        throw new ApiError(404, 'invalid_link', 'El enlace no existe, venció o fue revocado');
      }
      return db.transaction(async (tx) => {
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
