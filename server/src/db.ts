// Cliente de base de datos (Drizzle sobre pg) y migraciones.
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** Migraciones SQL generadas por drizzle-kit (server/drizzle/). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

export function createDb(databaseUrl: string): Db {
  return drizzle(new pg.Pool({ connectionString: databaseUrl }), { schema });
}

/** Aplica las migraciones pendientes (idempotente). */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}

/** Violación de unicidad de Postgres (23505), p. ej. un email repetido. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  // Drizzle envuelve el error de pg (cause).
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && (current as { code: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
