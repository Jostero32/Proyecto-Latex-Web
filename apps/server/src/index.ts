import type { ServiceName } from '@latexweb/shared';
import { buildApp } from './app';
import { loadConfig } from './config';
import { COLLAB_PATH } from './modules/collab/collab.websocket';

const service: ServiceName = 'server';
const { host, port } = loadConfig();

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
