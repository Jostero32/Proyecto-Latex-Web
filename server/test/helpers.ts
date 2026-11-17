// Utilidades de los tests del server: la base latexweb_test (la crea global-setup.ts).
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../src/db';

export const ORIGIN = 'http://localhost:5173';

export function testDb(): Db {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL: los tests del server se corren con `pnpm test` (global-setup.ts)');
  return createDb(url);
}

/** Vacía todas las tablas de la app. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE users, sessions CASCADE`);
}
