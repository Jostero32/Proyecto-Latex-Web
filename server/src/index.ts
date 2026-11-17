import { Redis } from 'ioredis';
import type { ServiceName } from '@latexweb/shared';
import { buildApp } from './app';
import { loadConfig } from './config';
import { closeDb, createDb, migrateDb } from './db';
import { createAuthService } from './features/auth/service';
import { COLLAB_PATH } from './features/collab/websocket';
import { createBullCompileQueue } from './features/compilations/queue';
import { createLocalCompilationsStorage, prepareStorageRoot } from './features/compilations/storage';

const service: ServiceName = 'server';
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();

  await prepareStorageRoot(config.compilations.storageDir);
  // Sin cola offline: si Redis no responde, los comandos fallan enseguida y la API devuelve 503
  // en lugar de dejar la petición colgada.
  const redis = new Redis(config.redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  redis.on('error', () => {
    // ioredis reintenta la conexión solo; los errores de cada comando se manejan donde se usan.
  });
  const queue = createBullCompileQueue(redis, config.compilations.ttlSeconds);
  const db = createDb(config.databaseUrl);
  await migrateDb(db);
  const auth = createAuthService(db);

  const app = await buildApp(
    {
      auth: { service: auth, cookieSecure: config.cookieSecure, redis },
      compilations: {
        queue,
        storage: createLocalCompilationsStorage(config.compilations.storageDir),
        config: config.compilations,
      },
      security: config.security,
    },
    // requestTimeout: tiempo máximo para recibir una petición completa (contra subidas lentas).
    { logger: true, requestTimeout: config.requestTimeoutMs },
  );

  // Sesiones vencidas: se rechazan al leerlas; el barrido solo libera espacio.
  const sweep = setInterval(() => {
    auth.sweepExpiredSessions().catch((error: unknown) => app.log.error({ err: error }, 'error en el barrido de sesiones'));
  }, SESSION_SWEEP_INTERVAL_MS);
  sweep.unref();

  app.addHook('onClose', async () => {
    clearInterval(sweep);
    await queue.close();
    await closeDb(db);
    redis.disconnect();
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `${service}: API en http://${config.host}:${config.port}/api y colaboración en ws://${config.host}:${config.port}${COLLAB_PATH}`,
  );

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(`[${service}] No se puede arrancar:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
