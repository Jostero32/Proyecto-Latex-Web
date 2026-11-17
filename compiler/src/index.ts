import { statfs } from 'node:fs/promises';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { COMPILE_QUEUE, type CompileJobData, type CompileJobResult, type ServiceName } from '@latexweb/shared';
import { loadConfig } from './config';
import { checkDocker, MIN_API_FOR_VOLUME_SUBPATH, resolveContainerUser } from './docker';
import { createCompileProcessor } from './processor';
import { createStorage } from './storage';
import { createLocalWorkspace, prepareWorkRoot } from './workspace';

const service: ServiceName = 'compiler';
/** Un directorio de trabajo más viejo que esto quedó de una caída (normalmente se borra al terminar). */
const STALE_WORK_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();

  const docker = await checkDocker(config.image, {
    // En modo volumen el aislamiento entre compilaciones depende de volume-subpath.
    minApiVersion: config.workVolume === undefined ? undefined : MIN_API_FOR_VOLUME_SUBPATH,
  });
  if (!docker.ok) {
    console.error(`[${service}] No se puede arrancar: ${docker.message}`);
    process.exit(1);
  }

  await prepareWorkRoot(config.workDir);
  const containerUser = resolveContainerUser();
  const workspace = createLocalWorkspace({
    root: config.workDir,
    maxPdfBytes: config.maxPdfBytes,
    maxLogBytes: config.maxLogBytes,
    containerUser,
  });
  const storage = createStorage(config.storage);

  // Restos de compilaciones interrumpidas: al arrancar y periódicamente.
  const sweep = async () => {
    try {
      const { removed, failed } = await workspace.sweepExpired(STALE_WORK_MS);
      if (removed.length > 0 || failed.length > 0) {
        console.log(`[${service}] barrido: ${removed.length} borradas, ${failed.length} para reintentar`);
      }
    } catch (error) {
      console.error(`[${service}] error en el barrido:`, error);
    }
  };
  await sweep();
  const sweepTimer = setInterval(() => void sweep(), config.sweepIntervalMs);
  sweepTimer.unref();

  // BullMQ exige maxRetriesPerRequest: null en las conexiones de workers.
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const processor = createCompileProcessor({
    ...config,
    workspace,
    storage,
    containerUser,
    // Un byte más que el mayor artefacto: un PDF que llega al tope queda en max + 1 y se detecta
    // como demasiado grande en lugar de publicarse truncado.
    maxFileBytes: Math.max(config.maxPdfBytes, config.maxLogBytes) + 1,
    freeBytes: async () => {
      const stats = await statfs(config.workDir);
      return stats.bavail * stats.bsize;
    },
  });
  const worker = new Worker<CompileJobData, CompileJobResult>(COMPILE_QUEUE, processor, {
    connection,
    concurrency: config.concurrency,
  });

  worker.on('ready', () =>
    console.log(
      `[${service}] escuchando la cola "${COMPILE_QUEUE}" (concurrencia ${config.concurrency}, imagen ${config.image}, trabajo en ${config.workDir})`,
    ),
  );
  worker.on('completed', (job, result) =>
    console.log(`[${service}] ${job.id}: ${result.outcome} en ${result.durationMs} ms`),
  );
  worker.on('failed', (job, error) => console.error(`[${service}] ${job?.id ?? '?'}: falló (${error.message})`));

  const shutdown = async () => {
    clearInterval(sweepTimer);
    await worker.close();
    connection.disconnect();
    storage.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(`[${service}] No se puede arrancar:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
