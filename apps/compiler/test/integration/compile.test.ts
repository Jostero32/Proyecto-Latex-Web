// Tests de integración con Docker real: workspace + docker-args + runner, sin la API.
// Ver docs/specs/compilacion.md, paso 5 y criterios de aceptación.
//
// Se corren con `pnpm test:integration` (no con `pnpm test`). Requieren Docker y la imagen
// (`pnpm --filter @latexweb/compiler image:build`); si faltan se saltan, salvo con
// LATEXWEB_REQUIRE_DOCKER=1 (CI), que los hace fallar.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE, detectEngineFromSource, type Engine } from '@latexweb/shared';
import { buildDockerRunArgs, containerName, resolveContainerUser } from '../../src/docker/docker-args';
import { classifyRun, runContainer } from '../../src/docker/runner';
import { createLocalWorkspace, type Workspace } from '../../src/workspace/workspace';

const IMAGE = process.env.COMPILE_IMAGE ?? 'latexweb-texlive:tl2026-1';
const FIXTURES = fileURLToPath(new URL('../../../../fixtures/latex/', import.meta.url));
const CANARY = 'LATEXWEB_CANARY';
const TEST_TIMEOUT_MS = 180_000;

const dockerReady =
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;

if (process.env.LATEXWEB_REQUIRE_DOCKER === '1' && !dockerReady) {
  throw new Error(`LATEXWEB_REQUIRE_DOCKER=1 pero Docker no responde o falta la imagen ${IMAGE}`);
}

interface CompileResult {
  outcome: string;
  exitCode: number | null;
  durationMs: number;
  hasPdf: boolean;
  hasLog: boolean;
  pdfHeader: string;
  log: string;
  id: string;
}

describe.skipIf(!dockerReady)('compilación con Docker real', () => {
  let root: string;
  let workspace: Workspace;
  const user = resolveContainerUser();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'latexweb-integration-'));
    workspace = createLocalWorkspace({
      root,
      maxPdfBytes: 50 * 1024 * 1024,
      maxLogBytes: 5 * 1024 * 1024,
      containerUser: user,
    });
    // Canario: si el entorno del worker llegara al contenedor, el fixture malicioso lo detecta.
    process.env[CANARY] = `secreto-${randomUUID()}`;
  });

  afterAll(async () => {
    delete process.env[CANARY];
    await rm(root, { recursive: true, force: true });
  });

  /** Copia un proyecto a input/ (como lo haría la API, pero sin filtrar latexmkrc) y lo compila. */
  async function compile(
    source: { fixture: string } | { files: Record<string, string> },
    options: { engine?: Engine; timeoutSeconds?: number } = {},
  ): Promise<CompileResult> {
    const id = randomUUID();
    const inputDir = join(root, id, 'input');
    if ('fixture' in source) {
      await cp(join(FIXTURES, source.fixture), inputDir, { recursive: true });
    } else {
      await mkdir(inputDir, { recursive: true });
      for (const [name, content] of Object.entries(source.files)) await writeFile(join(inputDir, name), content);
    }

    const engine =
      options.engine ?? detectEngineFromSource(await readFile(join(inputDir, 'main.tex'), 'utf8')) ?? DEFAULT_ENGINE;
    const timeoutSeconds = options.timeoutSeconds ?? 60;
    const paths = await workspace.prepareInputs(id);
    const run = await runContainer({
      containerName: containerName(id),
      timeoutSeconds,
      args: buildDockerRunArgs({
        compilationId: id,
        image: IMAGE,
        engine,
        mainFile: 'main.tex',
        ...paths,
        timeoutSeconds,
        cpus: 1,
        memory: '1g',
        pidsLimit: 128,
        tmpfsSize: '256m',
        user,
      }),
    });
    const published = await workspace.publishArtifacts(id);
    await workspace.cleanupWork(id);

    const classification = classifyRun(run, published.hasPdf);
    if (classification.kind === 'infrastructure') {
      throw new Error(`fallo de infraestructura: ${classification.reason}\n${run.stderrTail}`);
    }
    const pdf = published.hasPdf ? await readFile(join(root, id, 'output.pdf')) : null;
    return {
      id,
      outcome: classification.outcome,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      hasPdf: published.hasPdf,
      hasLog: published.hasLog,
      pdfHeader: pdf ? pdf.subarray(0, 5).toString('latin1') : '',
      log: published.hasLog ? await readFile(join(root, id, 'output.log'), 'latin1') : '',
    };
  }

  it.each(['articulo-simple', 'con-bibliografia', 'con-imagenes', 'beamer', 'xelatex-fuentes', 'malicioso'])(
    '%s compila con éxito y produce un PDF',
    async (fixture) => {
      const result = await compile({ fixture });
      expect(result.outcome, result.log.slice(-2000)).toBe('success');
      expect(result.pdfHeader).toBe('%PDF-');
      expect(result.log).toMatch(/Output written on output\.(pdf|xdv)/);
    },
    TEST_TIMEOUT_MS,
  );

  it('articulo-simple resuelve las referencias cruzadas', async () => {
    const { log } = await compile({ fixture: 'articulo-simple' });
    expect(log).not.toContain('There were undefined references');
  }, TEST_TIMEOUT_MS);

  it('con-bibliografia ejecuta biber y resuelve las citas', async () => {
    const { log } = await compile({ fixture: 'con-bibliografia' });
    expect(log).not.toMatch(/Citation .* undefined/);
    expect(log).not.toMatch(/Please \(re\)run Biber/);
  }, TEST_TIMEOUT_MS);

  it('beamer produce 5 páginas', async () => {
    const { log } = await compile({ fixture: 'beamer' });
    expect(log).toContain('Output written on output.pdf (5 pages');
  }, TEST_TIMEOUT_MS);

  it('xelatex-fuentes se compila con XeLaTeX por el comentario mágico', async () => {
    const { log } = await compile({ fixture: 'xelatex-fuentes' });
    expect(log).toMatch(/^This is XeTeX/m);
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

  it('un error de LaTeX termina en `error` (no en fallo de infraestructura) y deja el log', async () => {
    const result = await compile({
      files: { 'main.tex': '\\documentclass{article}\n\\begin{document}\n\\comandoquenoexiste\n\\end{document}\n' },
    });
    expect(result.outcome).toBe('error');
    expect(result.hasLog).toBe(true);
    expect(result.log).toContain('Undefined control sequence');
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
    const alive = spawnSync('docker', ['ps', '-aq', '--filter', `label=latexweb.compile=${result.id}`], {
      encoding: 'utf8',
    });
    expect(alive.stdout.trim()).toBe('');
  }, TEST_TIMEOUT_MS);
});
