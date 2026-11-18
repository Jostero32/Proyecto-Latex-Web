// Compilación real de punta a punta en el worker: el processor baja de MinIO la instantánea de un
// proyecto (los fixtures), compila en Docker y sube los artefactos. Corre con `pnpm test:compile`;
// requiere Docker, la imagen (`pnpm --filter @latexweb/compiler image:build`) y MinIO
// (`docker compose up -d minio`).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  compilationArtifactKey,
  compilationInputPrefix,
  DEFAULT_ENGINE,
  detectEngineFromSource,
  type CompileJobResult,
  type Engine,
} from '@latexweb/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyRun, containerName, resolveContainerUser, runContainer } from '../src/docker';
import { createCompileProcessor } from '../src/processor';
import { createStorage, type StorageConfig } from '../src/storage';
import { createLocalWorkspace } from '../src/workspace';

const IMAGE = process.env.COMPILE_IMAGE ?? 'latexweb-texlive:tl2026-2';
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const CANARY = 'LATEXWEB_CANARY';
const TEST_TIMEOUT_MS = 180_000;
const S3: StorageConfig = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:59000',
  region: 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY ?? 'latexweb',
  secretKey: process.env.S3_SECRET_KEY ?? 'latexweb-dev-secret',
  bucket: 'latexweb-test',
};

const dockerReady =
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;
if (!dockerReady) {
  throw new Error(`Docker no responde o falta la imagen ${IMAGE} (pnpm --filter @latexweb/compiler image:build)`);
}

interface Compiled extends CompileJobResult {
  id: string;
  pdfHeader: string;
  log: string;
}

describe('compilación real de proyectos', () => {
  const storage = createStorage(S3);
  let root: string;

  beforeAll(async () => {
    const client = new S3Client({
      endpoint: S3.endpoint,
      region: S3.region,
      forcePathStyle: true,
      credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey },
    });
    await client.send(new CreateBucketCommand({ Bucket: S3.bucket })).catch((error: { name?: string }) => {
      if (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists') {
        throw new Error(`MinIO no responde en ${S3.endpoint} (docker compose up -d minio)`, { cause: error });
      }
    });
    client.destroy();
    root = await mkdtemp(join(tmpdir(), 'latexweb-compile-'));
    // Canario: si el entorno del worker llegara al contenedor, el fixture malicioso lo detecta.
    process.env[CANARY] = `secreto-${randomUUID()}`;
  });

  afterAll(async () => {
    delete process.env[CANARY];
    storage.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Sube el proyecto como lo haría el server y lo compila con el processor del worker. */
  async function compile(
    source: { fixture: string } | { files: Record<string, string> },
    options: { engine?: Engine; timeoutSeconds?: number } = {},
  ): Promise<Compiled> {
    const id = randomUUID();
    const files: Record<string, Buffer> = {};
    if ('fixture' in source) {
      const dir = join(FIXTURES, source.fixture);
      for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        files[relative(dir, path).split('\\').join('/')] = await readFile(path);
      }
    } else {
      for (const [name, content] of Object.entries(source.files)) files[name] = Buffer.from(content);
    }
    for (const [path, data] of Object.entries(files)) await storage.put(compilationInputPrefix(id) + path, data);

    const engine = options.engine ?? detectEngineFromSource(files['main.tex']?.toString('utf8') ?? '') ?? DEFAULT_ENGINE;
    const processor = createCompileProcessor({
      workspace: createLocalWorkspace({ root, maxPdfBytes: 50 * 1024 * 1024, maxLogBytes: 5 * 1024 * 1024, containerUser: resolveContainerUser() }),
      storage,
      containerUser: resolveContainerUser(),
      image: IMAGE,
      timeoutSeconds: options.timeoutSeconds ?? 60,
      cpus: 1,
      memory: '1g',
      pidsLimit: 128,
      tmpfsSize: '256m',
      maxFileBytes: 52428801,
      maxInputBytes: 200 * 1024 * 1024,
      maxInputFiles: 500,
    });
    const result = await processor({ id, data: { compilationId: id, engine, mainFile: 'main.tex' } });
    const pdf = result.hasPdf ? await storage.getBuffer(compilationArtifactKey(id, 'pdf')) : null;
    const log = result.hasLog ? (await storage.getBuffer(compilationArtifactKey(id, 'log'))).toString('latin1') : '';
    return { ...result, id, pdfHeader: pdf ? pdf.subarray(0, 5).toString('latin1') : '', log };
  }

  it.each(['articulo-simple', 'con-bibliografia', 'con-imagenes', 'beamer', 'xelatex-fuentes', 'malicioso'])(
    '%s compila con éxito: PDF y SyncTeX en MinIO, sin errores en los diagnósticos',
    async (fixture) => {
      const result = await compile({ fixture });
      expect(result.outcome, result.log.slice(-2000)).toBe('success');
      expect(result.pdfHeader).toBe('%PDF-');
      expect(result.hasSynctex).toBe(true);
      expect(result.log).toMatch(/Output written on output\.(pdf|xdv)/);
      expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it('articulo-simple resuelve las referencias cruzadas y con-bibliografia, las citas', async () => {
    expect((await compile({ fixture: 'articulo-simple' })).log).not.toContain('There were undefined references');
    const { log } = await compile({ fixture: 'con-bibliografia' });
    expect(log).not.toMatch(/Citation .* undefined/);
    expect(log).not.toMatch(/Please \(re\)run Biber/);
  }, TEST_TIMEOUT_MS);

  it('beamer produce 5 páginas y xelatex-fuentes usa XeLaTeX por el comentario mágico', async () => {
    expect((await compile({ fixture: 'beamer' })).log).toContain('Output written on output.pdf (5 pages');
    expect((await compile({ fixture: 'xelatex-fuentes' })).log).toMatch(/^This is XeTeX/m);
  }, TEST_TIMEOUT_MS);

  it('malicioso: todos los intentos de escape quedan bloqueados', async () => {
    const { log, outcome } = await compile({ fixture: 'malicioso' });
    expect(outcome).toBe('success');
    expect(log).toContain('LATEXWEB-SANDBOX: FIN');
    for (const key of ['shell-escape-nivel', 'write18-ejecucion', 'write18-etc-passwd', 'canario-entorno', 'latexmkrc-perl']) {
      expect(log).toContain(`LATEXWEB-SANDBOX: ${key}=BLOQUEADO`);
    }
    expect(log).not.toContain('=VULNERABLE');
  }, TEST_TIMEOUT_MS);

  it('xelatex-fuentes forzado a lualatex compila y usa las cachés de la imagen', async () => {
    const result = await compile({ fixture: 'xelatex-fuentes' }, { engine: 'lualatex' });
    expect(result.outcome).toBe('success');
    expect(result.log).toMatch(/^This is LuaHBTeX/m);
    // Sin las cachés de luaotfload de la imagen tardaba ~20 s; con ellas, ~4 s.
    expect(result.log).not.toContain('Font names database not found');
    expect(result.durationMs).toBeLessThan(15_000);
  }, TEST_TIMEOUT_MS);

  it('un error de LaTeX termina en `error` con el archivo y la línea en los diagnósticos', async () => {
    const result = await compile({
      files: {
        'main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{capitulo}\n\\end{document}\n',
        'capitulo.tex': 'Hola\n\\comandoquenoexiste\n',
      },
    });
    expect(result.outcome).toBe('error');
    expect(result.hasLog).toBe(true);
    expect(result.diagnostics).toContainEqual({ file: 'capitulo.tex', line: 2, level: 'error', message: 'Undefined control sequence.' });
  }, TEST_TIMEOUT_MS);

  it('si el contenedor no respeta su timeout, el worker lo mata (respaldo) y no queda vivo', async () => {
    // `sleep` como entrypoint saltea el `timeout` del script: solo puede cortarlo el worker.
    const id = randomUUID();
    const name = containerName(id);
    const run = await runContainer({
      containerName: name,
      timeoutSeconds: 1,
      killGraceMs: 1_000,
      args: ['run', '--rm', '--name', name, '--label', `latexweb.compile=${id}`, '--network', 'none',
        '--entrypoint', 'sleep', IMAGE, '60'],
    });
    expect(run.killedByWorker).toBe(true);
    expect(run.durationMs).toBeLessThan(15_000);
    expect(classifyRun(run, false)).toEqual({ kind: 'outcome', outcome: 'timeout' });
    const alive = spawnSync('docker', ['ps', '-aq', '--filter', `label=latexweb.compile=${id}`], { encoding: 'utf8' });
    expect(alive.stdout.trim()).toBe('');
  }, TEST_TIMEOUT_MS);

  it('un bucle infinito termina en `timeout`, con log y sin contenedor vivo', async () => {
    const timeoutSeconds = 5;
    const result = await compile(
      { files: { 'main.tex': '\\documentclass{article}\n\\begin{document}\n\\def\\x{\\x}\\x\n\\end{document}\n' } },
      { timeoutSeconds },
    );
    expect(result.outcome).toBe('timeout');
    expect(result.durationMs).toBeLessThan((timeoutSeconds + 20) * 1000);
    expect(result.hasLog).toBe(true);
    const alive = spawnSync('docker', ['ps', '-aq', '--filter', `label=latexweb.compile=${result.id}`], { encoding: 'utf8' });
    expect(alive.stdout.trim()).toBe('');
  }, TEST_TIMEOUT_MS);
});
