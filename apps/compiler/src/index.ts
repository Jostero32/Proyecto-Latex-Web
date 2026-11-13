import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { COMPILE_QUEUE, type ServiceName } from '@latexweb/shared';

const service: ServiceName = 'compiler';

// BullMQ exige maxRetriesPerRequest: null en las conexiones de workers
const connection = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  COMPILE_QUEUE,
  async () => {
    throw new Error('Compilación no implementada');
  },
  { connection },
);

worker.on('ready', () => console.log(`${service} escuchando la cola "${COMPILE_QUEUE}"`));

const shutdown = async () => {
  await worker.close();
  connection.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
