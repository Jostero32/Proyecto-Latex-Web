import type { ServiceName } from '@latexweb/shared';
import { buildApp } from './app';
import { COLLAB_PATH } from './collab';

const service: ServiceName = 'server';
const port = Number(process.env.SERVER_PORT ?? 3000);
const host = '127.0.0.1';

const app = buildApp({ logger: true });

try {
  await app.listen({ port, host });
  app.log.info(`${service}: API en http://${host}:${port} y colaboración en ws://${host}:${port}${COLLAB_PATH}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
