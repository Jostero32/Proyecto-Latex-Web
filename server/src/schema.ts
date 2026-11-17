// Modelo de datos (Drizzle). Después de cambiarlo: `pnpm db:generate` crea la migración en drizzle/,
// y el server la aplica al arrancar.
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** En minúsculas y sin espacios (normalizeEmail). */
  email: text('email').notNull().unique(),
  name: text('name'),
  /** argon2id (formato PHC). */
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 (hex) del token de la cookie: el token nunca se guarda. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId), index('sessions_expires_at_idx').on(table.expiresAt)],
);

export type User = typeof users.$inferSelect;
