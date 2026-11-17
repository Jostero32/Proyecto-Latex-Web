import { Redis } from 'ioredis';
import type { ServiceName } from '@latexweb/shared';
import { buildApp } from './app';
import { loadConfig } from './config';
import { COLLAB_PATH } from './features/collab';
import { createBullCompileQueue } from './features/compilations';
import { createLocalCompilationsStorage, prepareStorageRoot } from './features/compilations';

const service: ServiceName = 'server';

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

  const app = await buildApp(
    {
      compilations: {
        queue,
        storage: createLocalCompilationsStorage(config.compilations.storageDir),
        config: config.compilations,
      },
    },
    { logger: true },
  );
  app.addHook('onClose', async () => {
    await queue.close();
    redis.disconnect();
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `${service}: API en http://${config.host}:${config.port} y colaboración en ws://${config.host}:${config.port}${COLLAB_PATH}`,
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
