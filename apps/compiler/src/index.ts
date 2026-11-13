import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { COMPILE_QUEUE, type ServiceName } from '@latexweb/shared';
import { loadConfig } from './config';
import { processCompileJob } from './worker/processor';

const service: ServiceName = 'compiler';
const config = loadConfig();

// BullMQ exige maxRetriesPerRequest: null en las conexiones de workers
const connection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

const worker = new Worker(COMPILE_QUEUE, processCompileJob, { connection });

worker.on('ready', () => console.log(`${service} escuchando la cola "${COMPILE_QUEUE}"`));

const shutdown = async () => {
  await worker.close();
  connection.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
