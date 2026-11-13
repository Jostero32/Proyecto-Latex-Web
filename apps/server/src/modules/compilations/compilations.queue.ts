// Acceso a la cola `compile` desde la API: encolar y consultar el estado. La fuente de verdad del
// estado es el job de BullMQ (no hay base de datos en v1). Interfaz chica para poder usar una cola
// falsa en los tests.
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { COMPILE_QUEUE, type CompileJobData, type CompileJobResult } from '@latexweb/shared';

export type JobState = 'queued' | 'running' | 'completed' | 'failed';

export interface JobSnapshot {
  state: JobState;
  data: CompileJobData;
  /** Solo con state 'completed'. */
  result?: CompileJobResult;
  createdAt: number;
  finishedAt?: number;
}

export interface CompileQueue {
  add(data: CompileJobData): Promise<void>;
  waitingCount(): Promise<number>;
  /** null si el job no existe (nunca existió o BullMQ ya lo borró). */
  get(id: string): Promise<JobSnapshot | null>;
  close(): Promise<void>;
}

/** `name` solo se cambia en tests, para no compartir la cola con un worker real. */
export function createBullCompileQueue(connection: Redis, ttlSeconds: number, name: string = COMPILE_QUEUE): CompileQueue {
  const queue = new Queue<CompileJobData, CompileJobResult>(name, { connection });

  return {
    async add(data) {
      await queue.add('compile', data, {
        jobId: data.compilationId,
        attempts: 1,
        removeOnComplete: { age: ttlSeconds, count: 1000 },
        removeOnFail: { age: ttlSeconds, count: 1000 },
      });
    },

    async waitingCount() {
      return queue.getWaitingCount();
    },

    async get(id) {
      // Primero el estado y después el job: si el job termina entre las dos lecturas, en este
      // orden solo se informa 'running' un instante de más. Al revés (job y después estado) se
      // podía leer 'completed' con un job leído antes de terminar, sin returnvalue.
      const bullState = await queue.getJobState(id);
      const state = mapState(bullState);
      if (state === null) return null;
      const job = await queue.getJob(id);
      if (!job) return null;
      const snapshot: JobSnapshot = { state, data: job.data, createdAt: job.timestamp };
      if (job.finishedOn !== undefined) snapshot.finishedAt = job.finishedOn;
      if (state === 'completed' && job.returnvalue) snapshot.result = job.returnvalue;
      return snapshot;
    },

    async close() {
      await queue.close();
    },
  };
}

/** Correspondencia de estados de la spec ("Estados y resultado"). */
export function mapState(bullState: string): JobState | null {
  switch (bullState) {
    case 'waiting':
    case 'delayed':
    case 'prioritized':
    case 'waiting-children':
      return 'queued';
    case 'active':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return null; // 'unknown'
  }
}
