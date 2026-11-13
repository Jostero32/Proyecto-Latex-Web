// Tests de checkDocker sin Docker: node (process.execPath) hace de docker falso, como en runner.test.ts.
// `node version ...` e `node image ...` fallan solos (no existen esos scripts). Para simular un docker
// que sí responde a `version`, se precarga un módulo con NODE_OPTIONS=--require que, según el
// subcomando (process.argv[1]), sale con el código que pide FAKE_DOCKER_INSPECT_CODE. Evita crear
// scripts .cmd, que spawn rechaza con EINVAL en Windows.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkDocker } from './docker-check';

let dir: string;
let preload: string;
const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, FAKE: process.env.FAKE_DOCKER_INSPECT_CODE };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'latexweb-dockercheck-'));
  preload = join(dir, 'fake-docker.cjs').replaceAll('\\', '/');
  await writeFile(
    preload,
    `const sub = require('node:path').basename(process.argv[1] ?? '');
if (sub === 'version') { console.log('27.0.0'); process.exit(0); }
if (sub === 'image') { console.error('Error: No such image'); process.exit(Number(process.env.FAKE_DOCKER_INSPECT_CODE ?? 1)); }
`,
  );
});

afterEach(() => {
  restore('NODE_OPTIONS', saved.NODE_OPTIONS);
  restore('FAKE_DOCKER_INSPECT_CODE', saved.FAKE);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function useFakeDocker(inspectCode: number): void {
  process.env.NODE_OPTIONS = `--require "${preload}"`;
  process.env.FAKE_DOCKER_INSPECT_CODE = String(inspectCode);
}

describe('checkDocker', () => {
  it('con un dockerBin inexistente devuelve ok: false, menciona Docker y no lanza', async () => {
    const result = await checkDocker('latexweb-texlive:test', join(dir, 'no-existe-docker'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Docker');
  });

  it('si version falla (código distinto de 0) devuelve ok: false', async () => {
    const result = await checkDocker('img:1', process.execPath); // `node version` falla
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Docker');
  });

  it('si version funciona e image inspect falla, pide image:build y nombra la imagen', async () => {
    useFakeDocker(1);
    const result = await checkDocker('mi-imagen:9', process.execPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('mi-imagen:9');
      expect(result.message).toContain('image:build');
    }
  });

  it('si version e image inspect funcionan devuelve ok: true', async () => {
    useFakeDocker(0);
    expect(await checkDocker('mi-imagen:9', process.execPath)).toEqual({ ok: true });
  });
});
