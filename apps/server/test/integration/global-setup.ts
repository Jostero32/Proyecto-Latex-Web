// globalSetup de los tests de integración: recrea la base `latexweb_test` y le aplica las
// migraciones. Si Postgres no responde, deja TEST_DATABASE_URL vacía y los tests de base de datos
// se saltan (salvo con LATEXWEB_REQUIRE_POSTGRES=1, que falla).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://latexweb:latexweb@127.0.0.1:5432/latexweb';
const TEST_DB = 'latexweb_test';
const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    if (process.env.LATEXWEB_REQUIRE_POSTGRES === '1') {
      throw new Error(`LATEXWEB_REQUIRE_POSTGRES=1 pero Postgres no responde en ${ADMIN_URL}`, { cause: error });
    }
    process.env.TEST_DATABASE_URL = '';
    return;
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url)), 'migrate', 'deploy'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
  });
  process.env.TEST_DATABASE_URL = url.toString();
}
