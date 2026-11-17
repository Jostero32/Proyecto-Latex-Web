// MinIO (API S3) desde el worker: bajar la instantánea del proyecto y subir los artefactos.
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface StoredObject {
  key: string;
  size: number;
}

export interface Storage {
  list(prefix: string): Promise<StoredObject[]>;
  getBuffer(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  close(): void;
}

export function createStorage(config: StorageConfig): Storage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = config.bucket;
  return {
    async list(prefix) {
      const objects: StoredObject[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of page.Contents ?? []) if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0 });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
    async getBuffer(key) {
      const object = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!object.Body) throw new Error(`objeto vacío: ${key}`);
      return Buffer.from(await object.Body.transformToByteArray());
    },
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentLength: body.length, ...(contentType ? { ContentType: contentType } : {}) }),
      );
    },
    close() {
      client.destroy();
    },
  };
}
