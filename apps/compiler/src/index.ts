import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { COMPILE_QUEUE, type CompileJobData, type CompileJobResult, type ServiceName } from '@latexweb/shared';
import { loadConfig } from './config';
import { checkDocker, MIN_API_FOR_VOLUME_SUBPATH } from './docker/docker-check';
import { resolveContainerUser } from './docker/docker-args';
import { createLocalWorkspace, prepareStorageRoot } from './workspace/workspace';
import { createCompileProcessor } from './worker/processor';

const service: ServiceName = 'compiler';

async function main(): Promise<void> {
  const config = loadConfig();

  const docker = await checkDocker(config.image, {
    // En modo volumen el aislamiento entre compilaciones depende de volume-subpath.
    minApiVersion: config.storageVolume === undefined ? undefined : MIN_API_FOR_VOLUME_SUBPATH,
  });
  if (!docker.ok) {
    console.error(`[${service}] No se puede arrancar: ${docker.message}`);
    process.exit(1);
  }

  await prepareStorageRoot(config.storageDir);
  const containerUser = resolveContainerUser();
  const workspace = createLocalWorkspace({
    root: config.storageDir,
    maxPdfBytes: config.maxPdfBytes,
    maxLogBytes: config.maxLogBytes,
    containerUser,
  });

  // Barrido de compilaciones vencidas: al arrancar y periódicamente.
  const sweep = async () => {
    try {
      const { removed, failed } = await workspace.sweepExpired(config.ttlSeconds * 1000);
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
  const processor = createCompileProcessor({ workspace, containerUser, ...config });
  const worker = new Worker<CompileJobData, CompileJobResult>(COMPILE_QUEUE, processor, {
    connection,
    concurrency: config.concurrency,
  });

  worker.on('ready', () =>
    console.log(
      `[${service}] escuchando la cola "${COMPILE_QUEUE}" (concurrencia ${config.concurrency}, imagen ${config.image}, almacenamiento ${config.storageDir})`,
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
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(`[${service}] No se puede arrancar:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
