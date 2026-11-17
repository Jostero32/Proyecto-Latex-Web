// Almacenamiento de objetos (MinIO, API S3): binarios de los proyectos y, desde el paso 4, las
// compilaciones. Claves: projects/<projectId>/files/<fileId> y compilations/<id>/… (ver shared).
import type { Readable } from 'node:stream';
import { COMPILATIONS_PREFIX } from '@latexweb/shared';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface Storage {
  put(key: string, body: Buffer): Promise<void>;
  /** Copia dentro del bucket (sin pasar los bytes por el server). */
  copy(from: string, to: string): Promise<void>;
  /** Contenido como stream; null si no existe. */
  get(key: string): Promise<Readable | null>;
  getBuffer(key: string): Promise<Buffer | null>;
  delete(keys: readonly string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Crea el bucket si no existe y le pone la regla que borra las compilaciones al día. */
  ensureBucket(): Promise<void>;
  close(): void;
}

export const fileKey = (projectId: string, fileId: string) => `projects/${projectId}/files/${fileId}`;
export const projectPrefix = (projectId: string) => `projects/${projectId}/`;

/** Máximo de claves por DeleteObjects (límite de S3). */
const DELETE_BATCH = 1000;

export function createStorage(config: StorageConfig): Storage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    // MinIO: bucket en la ruta, no en el subdominio.
    forcePathStyle: true,
    // Las sumas de verificación por defecto del SDK (CRC32 en cada PUT) no hacen falta con MinIO.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = config.bucket;

  async function deleteBatch(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
    }
  }

  const storage: Storage = {
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentLength: body.length }));
    },
    async copy(from, to) {
      await client.send(new CopyObjectCommand({ Bucket, Key: to, CopySource: `${Bucket}/${from}` }));
    },
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return (object.Body as Readable | undefined) ?? null;
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },
    async getBuffer(key) {
      const stream = await storage.get(key);
      if (!stream) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    },
    async delete(keys) {
      if (keys.length > 0) await deleteBatch(keys);
    },
    async deletePrefix(prefix) {
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        await storage.delete((page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : [])));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }));
      }
      // Retención de las compilaciones (instantánea y artefactos): la hace MinIO, sin barrido propio.
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket,
          LifecycleConfiguration: {
            Rules: [{ ID: 'compilaciones', Status: 'Enabled', Filter: { Prefix: COMPILATIONS_PREFIX }, Expiration: { Days: 1 } }],
          },
        }),
      );
    },
    close() {
      client.destroy();
    },
  };
  return storage;
}
