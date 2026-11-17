// Todas las tablas. Para cambiarlas: editar aquí y `pnpm db:generate` (el server migra al arrancar).
import { ASSIGNABLE_ROLES, ENGINES, FILE_KINDS, PROJECT_ROLES } from '@latexweb/shared';
import { sql } from 'drizzle-orm';
import { bigint, customType, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value),
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();


export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId), index('sessions_expires_at_idx').on(table.expiresAt)],
);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  mainFile: text('main_file').notNull().default('main.tex'),
  engine: text('engine', { enum: ENGINES }).notNull().default('pdflatex'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: PROJECT_ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] }), index('project_members_user_id_idx').on(table.userId)],
);

/** El árbol del proyecto. El texto de los archivos `text` vive en `documents`; los binarios, en S3. */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** NFC y minúsculas: dos rutas que solo difieren en mayúsculas chocan (NTFS y APFS no las distinguen). */
    pathKey: text('path_key').notNull(),
    kind: text('kind', { enum: FILE_KINDS }).notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('files_project_path_key_idx').on(table.projectId, table.pathKey)],
);

/** Estado del Y.Doc del proyecto (update de Yjs), con un Y.Text por archivo de texto. */
export const documents = pgTable('documents', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: updatedAt(),
});

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** sha256 del token: el token solo se muestra al crearlo. */
    tokenHash: text('token_hash').notNull().unique(),
    role: text('role', { enum: ASSIGNABLE_ROLES }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('share_links_project_id_idx').on(table.projectId).where(sql`${table.revokedAt} is null`)],
);

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type FileRow = typeof files.$inferSelect;
