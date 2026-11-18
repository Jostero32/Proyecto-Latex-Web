// Proyectos y archivos de punta a punta contra Postgres y MinIO reales: CRUD, imágenes, texto en el
// Y.Doc, árbol y topes, y el viaje de ida y vuelta del zip.
import type { ProjectFile, ProjectSummary } from '@latexweb/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db';
import { fileKey } from '../src/storage';
import { LIMITS, makeZip, projectsApp, resetDb, testDb, testStorage, type Client, type ProjectsHarness } from './helpers';

const db = testDb();
const storage = testStorage();
afterAll(async () => {
  await closeDb(db);
  storage.close();
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let harness: ProjectsHarness;
let ana: Client;

beforeEach(async () => {
  await resetDb(db);
  harness = await projectsApp(db, storage);
  ana = await harness.user('ana@ejemplo.com');
});
afterEach(async () => {
  await harness.app.close();
});

async function createProject(name = 'Tesis'): Promise<ProjectSummary> {
  const res = await ana.post('/api/projects', { name });
  expect(res.statusCode).toBe(201);
  return res.json<{ project: ProjectSummary }>().project;
}

async function listFiles(projectId: string): Promise<ProjectFile[]> {
  return (await ana.get(`/api/projects/${projectId}/files`)).json<{ files: ProjectFile[] }>().files;
}

describe('proyectos', () => {
  it('crear con main.tex de plantilla, listar con mi rol, ver, cambiar y borrar', async () => {
    const project = await createProject('  Tesis  ');
    expect(project).toMatchObject({ name: 'Tesis', mainFile: 'main.tex', engine: 'pdflatex', role: 'owner' });

    const [main] = await listFiles(project.id);
    expect(main).toMatchObject({ path: 'main.tex', kind: 'text' });
    expect((await ana.get(`/api/projects/${project.id}/files/${main?.id}`)).body).toContain('\\documentclass');

    expect((await ana.get('/api/projects')).json()).toEqual({ projects: [project] });
    expect((await ana.get(`/api/projects/${project.id}`)).json()).toEqual({ project });

    const patched = await ana.patch(`/api/projects/${project.id}`, { name: 'Tesis final', engine: 'xelatex' });
    expect(patched.json()).toMatchObject({ project: { name: 'Tesis final', engine: 'xelatex' } });
    for (const [body, code] of [
      [{ engine: 'latex' }, 'invalid_engine'],
      [{ mainFile: 'no-existe.tex' }, 'invalid_main_file'],
      [{ name: '' }, 'invalid_name'],
    ] as const) {
      expect((await ana.patch(`/api/projects/${project.id}`, body)).json()).toMatchObject({ error: code });
    }

    expect((await ana.delete(`/api/projects/${project.id}`)).statusCode).toBe(204);
    expect((await ana.get(`/api/projects/${project.id}`)).statusCode).toBe(404);
    expect((await ana.get('/api/projects')).json()).toEqual({ projects: [] });
  });

  it('sin sesión: 401', async () => {
    expect((await harness.app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
  });
});

describe('archivos', () => {
  it('sube imágenes y texto, los sirve, edita el texto, renombra y borra', async () => {
    const project = await createProject();
    const base = `/api/projects/${project.id}/files`;
    const up = await ana.upload(base, { 'figuras/logo.png': PNG, 'capitulos/intro.tex': 'Hola \\textbf{mundo}' });
    expect(up.statusCode).toBe(201);
    const uploaded = up.json<{ files: ProjectFile[] }>().files;
    const png = uploaded.find((f) => f.path === 'figuras/logo.png');
    const intro = uploaded.find((f) => f.path === 'capitulos/intro.tex');
    expect(png).toMatchObject({ kind: 'binary', size: PNG.length });
    expect(intro).toMatchObject({ kind: 'text' });
    expect((await listFiles(project.id)).map((f) => f.path)).toEqual(['capitulos/intro.tex', 'figuras/logo.png', 'main.tex']);

    // La imagen: bytes exactos, inline y sin que el navegador la interprete como otra cosa.
    const image = await ana.get(`${base}/${png?.id}`);
    expect(Buffer.compare(image.rawPayload, PNG)).toBe(0);
    expect(image.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'private, no-store',
    });
    expect(image.headers['content-disposition']).toMatch(/^inline; filename="logo.png"/);

    // Texto: PUT reemplaza; la misma ruta con otras mayúsculas también reemplaza (mismo id).
    expect((await ana.put(`${base}/${intro?.id}`, 'Introducción ✓')).json()).toMatchObject({ file: { size: 17 } });
    expect((await ana.get(`${base}/${intro?.id}`)).body).toBe('Introducción ✓');
    const again = await ana.upload(base, { 'Capitulos/INTRO.tex': 'otra vez' });
    expect(again.json<{ files: ProjectFile[] }>().files).toEqual([expect.objectContaining({ id: intro?.id, path: 'capitulos/intro.tex' })]);
    expect((await ana.get(`${base}/${intro?.id}`)).body).toBe('otra vez');
    expect((await ana.put(`${base}/${png?.id}`, 'x')).json()).toMatchObject({ error: 'not_text' });

    // Renombrar main.tex lo sigue como documento principal.
    const main = (await listFiles(project.id)).find((f) => f.path === 'main.tex');
    expect((await ana.patch(`${base}/${main?.id}`, { path: 'src/main.tex' })).json()).toMatchObject({ file: { path: 'src/main.tex' } });
    expect((await ana.get(`/api/projects/${project.id}`)).json()).toMatchObject({ project: { mainFile: 'src/main.tex' } });

    // Borrar un binario borra el objeto.
    expect((await ana.delete(`${base}/${png?.id}`)).statusCode).toBe(204);
    expect(await storage.get(fileKey(project.id, png?.id ?? ''))).toBeNull();
    expect((await ana.get(`${base}/${png?.id}`)).statusCode).toBe(404);
  });

  it('rechaza rutas inválidas, choques y lo que supera los topes, sin escribir nada', async () => {
    const project = await createProject();
    const base = `/api/projects/${project.id}/files`;
    await ana.upload(base, { 'figuras/a.png': PNG });
    const cases: [Record<string, string | Buffer>, number, string][] = [
      [{ '../x.tex': 'x' }, 400, 'invalid_path'],
      [{ '.latexmkrc': 'x' }, 400, 'invalid_path'],
      [{ 'sub/latexmkrc': 'x' }, 400, 'invalid_path'],
      [{ figuras: 'x' }, 409, 'path_conflict'],
      [{ 'main.tex/x.tex': 'x' }, 409, 'path_conflict'],
      [{ 'a.tex': 'x', 'A.TEX': 'y' }, 409, 'path_conflict'],
      [Object.fromEntries(Array.from({ length: LIMITS.maxFiles }, (_, i) => [`f${i}.tex`, 'x'])), 413, 'too_many_files'],
      [{ 'grande.bin': Buffer.alloc(LIMITS.fileMaxBytes + 1) }, 413, 'payload_too_large'],
    ];
    for (const [files, status, code] of cases) {
      const res = await ana.upload(base, files);
      expect([res.statusCode, res.json().error]).toEqual([status, code]);
    }
    const [png] = (await listFiles(project.id)).filter((f) => f.kind === 'binary');
    expect((await ana.patch(`${base}/${png?.id}`, { path: 'MAIN.tex' })).json()).toMatchObject({ error: 'path_conflict' });
    expect((await listFiles(project.id)).map((f) => f.path)).toEqual(['figuras/a.png', 'main.tex']);
  });
});

describe('zip', () => {
  it('elige como principal la tesis (aunque tenga espacios), no una figura standalone suelta', async () => {
    const zip = await makeZip([
      { name: 'arbol_problemas.tex', data: '\\documentclass[tikz]{standalone}\n\\begin{document}x\\end{document}' },
      { name: 'Anexo 2.tex', data: '\\documentclass[12pt]{article}\n\\begin{document}\nTesis larga.\n\\end{document}' },
    ]);
    const imported = await ana.upload('/api/projects/import', { 'Anexo 2.zip': zip });
    expect(imported.json<{ project: ProjectSummary }>().project.mainFile).toBe('Anexo 2.tex');
  });

  it('importar y exportar conserva rutas, texto y binarios', async () => {
    const zip = await makeZip([
      { name: 'informe/tesis.tex', data: '% !TEX program = lualatex\n\\documentclass{book}' },
      { name: 'informe/capitulos/uno.tex', data: 'Capítulo uno' },
      { name: 'informe/img/foto.png', data: PNG },
      { name: 'informe/.git/config' },
    ]);
    const imported = await ana.upload('/api/projects/import', { 'informe.zip': zip });
    expect(imported.statusCode).toBe(201);
    const project = imported.json<{ project: ProjectSummary }>().project;
    // Nombre del zip, documento principal y motor detectados.
    expect(project).toMatchObject({ name: 'informe', mainFile: 'tesis.tex', engine: 'lualatex', role: 'owner' });

    const exported = await ana.get(`/api/projects/${project.id}/export`);
    expect(exported.headers['content-type']).toBe('application/zip');
    expect(exported.headers['content-disposition']).toMatch(/^attachment; filename="informe.zip"/);

    const again = await ana.upload('/api/projects/import', { 'copia.zip': exported.rawPayload }, { name: 'Copia' });
    const copy = again.json<{ project: ProjectSummary }>().project;
    expect(copy.name).toBe('Copia');
    const files = await listFiles(copy.id);
    expect(files.map((f) => [f.path, f.kind])).toEqual([
      ['capitulos/uno.tex', 'text'],
      ['img/foto.png', 'binary'],
      ['tesis.tex', 'text'],
    ]);
    const read = (path: string) => ana.get(`/api/projects/${copy.id}/files/${files.find((f) => f.path === path)?.id}`);
    expect((await read('capitulos/uno.tex')).body).toBe('Capítulo uno');
    expect(Buffer.compare((await read('img/foto.png')).rawPayload, PNG)).toBe(0);
  });

  it('un zip inválido no crea el proyecto', async () => {
    const bad = await makeZip([{ name: 'main.tex' }, { name: 'enlace', data: '/etc/passwd', mode: 0o120777 }]);
    expect((await ana.upload('/api/projects/import', { 'x.zip': bad })).json()).toMatchObject({ error: 'invalid_zip' });
    expect((await ana.get('/api/projects')).json()).toEqual({ projects: [] });
  });
});
