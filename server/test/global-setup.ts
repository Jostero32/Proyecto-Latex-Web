// globalSetup de `pnpm test`: recrea la base `latexweb_test` y le aplica las migraciones. Los tests
// del server la usan con TEST_DATABASE_URL.
import pg from 'pg';
import { closeDb, createDb, migrateDb } from '../src/db';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://latexweb:latexweb@127.0.0.1:5432/latexweb';
const TEST_DB = 'latexweb_test';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Postgres no responde en ${ADMIN_URL}. Levantar la infraestructura: docker compose up -d postgres redis minio`,
      { cause: error },
    );
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  const db = createDb(url.toString());
  try {
    await migrateDb(db);
  } finally {
    await closeDb(db);
  }
  process.env.TEST_DATABASE_URL = url.toString();
}
