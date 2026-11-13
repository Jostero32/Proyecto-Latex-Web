// Integración con Redis real: el estado que informa la API mientras los jobs terminan.
// Regresión de una carrera vista en la prueba de punta a punta (paso 9 de la spec de compilación):
// get() leía el job y después su estado; si el job terminaba entre las dos lecturas, informaba
// 'completed' sin resultado y la API respondía un 'failed' falso.
//
// Se salta si Redis no responde, salvo con LATEXWEB_REQUIRE_REDIS=1.
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompileJobData, CompileJobResult } from '@latexweb/shared';
import { createBullCompileQueue, type CompileQueue } from '../../src/features/compilations/queue';
import { buildStatusResponse } from '../../src/features/compilations/status';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

async function redisReady(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
  probe.on('error', () => {});
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const ready = await redisReady();
if (process.env.LATEXWEB_REQUIRE_REDIS === '1' && !ready) throw new Error(`LATEXWEB_REQUIRE_REDIS=1 pero Redis no responde en ${REDIS_URL}`);

describe.skipIf(!ready)('cola de compilación con Redis real', () => {
  const name = `compile-test-${randomUUID()}`;
  let connection: Redis;
  let workerConnection: Redis;
  let queue: CompileQueue;
  let worker: Worker<CompileJobData, CompileJobResult>;

  beforeAll(async () => {
    connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    workerConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    queue = createBullCompileQueue(connection, 3600, name);
    // Worker que termina enseguida: maximiza la probabilidad de terminar entre dos lecturas.
    worker = new Worker<CompileJobData, CompileJobResult>(
      name,
      async () => ({ outcome: 'error', exitCode: 12, durationMs: 1, hasPdf: false, hasLog: true, pdfMissingReason: 'not_produced' }),
      { connection: workerConnection, concurrency: 4 },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    const raw = new Queue(name, { connection });
    await raw.obliterate({ force: true });
    await raw.close();
    await queue.close();
    connection.disconnect();
    workerConnection.disconnect();
  });

  it('mientras los jobs terminan, nunca informa completed sin resultado ni un failed falso', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const id = randomUUID();
      await queue.add({ compilationId: id, mainFile: 'main.tex', engine: 'pdflatex' });
      for (;;) {
        const job = await queue.get(id);
        expect(job, 'el job tiene que existir').not.toBeNull();
        if (!job) break;
        if (job.state === 'completed') expect(job.result, 'completed siempre con resultado').toBeDefined();
        const status = buildStatusResponse(id, job, 3600).status;
        seen.add(status);
        expect(status).not.toBe('failed');
        if (status === 'error') break;
      }
    }
    // Se llegó al estado final en todos los casos.
    expect(seen.has('error')).toBe(true);
  }, 60_000);
});
