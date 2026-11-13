// Prueba de punta a punta de la compilación a través de la API. Sin dependencias (Node 22).
// Uso: node .claude/skills/probar-compilacion/probar.mjs [--base URL] [--fixtures DIR] [--timeout SEG]
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[i + 1]]] : pairs), []),
);
const BASE = (args.base ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const FIXTURES = args.fixtures ?? 'fixtures/latex';
const TIMEOUT_MS = Number(args.timeout ?? 120) * 1000;
const FINAL = new Set(['success', 'error', 'timeout', 'failed']);

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function firstError(log, fixture) {
  if (fixture === 'malicioso') {
    const vulnerable = log.split(/\r?\n/).find((l) => /^LATEXWEB-SANDBOX: .*=VULNERABLE/.test(l));
    if (vulnerable) return vulnerable;
  }
  const lines = log.split(/\r?\n/);
  const i = lines.findIndex((l) => /^! /.test(l) || /^[^\s:]+\.\w+:\d+: /.test(l));
  return i === -1 ? '' : lines.slice(i, i + 2).join(' ').trim().slice(0, 160);
}

async function run(fixture) {
  const dir = join(FIXTURES, fixture);
  const form = new FormData();
  for (const file of await listFiles(dir)) {
    const rel = relative(dir, file).split(sep).join('/');
    form.append('files', new Blob([await readFile(file)]), rel);
  }

  const started = Date.now();
  const row = { fixture, estado: '-', tiempo: '-', pdf: '-', error: '', notas: [] };

  const created = await fetch(`${BASE}/compilations`, { method: 'POST', body: form });
  const createdBody = await created.json().catch(() => ({}));
  if (created.status !== 202) {
    row.estado = `HTTP ${created.status}`;
    row.error = JSON.stringify(createdBody).slice(0, 160);
    return row;
  }
  if (createdBody.ignoredFiles?.length) row.notas.push(`ignorados: ${createdBody.ignoredFiles.join(', ')}`);
  row.notas.push(`motor: ${createdBody.engine}`);

  let status;
  while (Date.now() - started < TIMEOUT_MS) {
    const res = await fetch(`${BASE}/compilations/${createdBody.id}`);
    status = await res.json();
    if (res.status !== 200) {
      row.estado = `HTTP ${res.status}`;
      row.error = JSON.stringify(status).slice(0, 160);
      return row;
    }
    if (FINAL.has(status.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  row.tiempo = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  row.estado = status && FINAL.has(status.status) ? status.status : 'sin terminar (timeout del script)';
  if (status?.pdfMissingReason) row.notas.push(`pdfMissingReason: ${status.pdfMissingReason}`);

  const pdf = await fetch(`${BASE}/compilations/${createdBody.id}/pdf`);
  if (pdf.ok) {
    const head = Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('latin1');
    row.pdf = head === '%PDF-' ? 'sí' : `inválido (${JSON.stringify(head)})`;
  } else {
    const body = await pdf.json().catch(() => ({}));
    row.pdf = `no (${pdf.status} ${body.error ?? ''})`.trim();
  }

  const log = await fetch(`${BASE}/compilations/${createdBody.id}/log`);
  if (log.ok) {
    row.error = firstError(await log.text(), fixture);
  } else {
    row.notas.push(`log: HTTP ${log.status}`);
  }
  return row;
}

const fixtures = (await readdir(FIXTURES, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const rows = [];
for (const fixture of fixtures) {
  try {
    rows.push(await run(fixture));
  } catch (error) {
    rows.push({ fixture, estado: 'error del script', tiempo: '-', pdf: '-', error: String(error).slice(0, 160), notas: [] });
  }
}

const cell = (s) => String(s || '—').replace(/\|/g, '\\|');
console.log('| Fixture | Estado | Tiempo | PDF | Primer error | Notas |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${cell(r.fixture)} | ${cell(r.estado)} | ${cell(r.tiempo)} | ${cell(r.pdf)} | ${cell(r.error)} | ${cell(r.notas.join('; '))} |`);

const ok = rows.every((r) => r.estado === 'success' && r.pdf === 'sí' && !/VULNERABLE/.test(r.error));
console.log(`\nResultado: ${ok ? 'OK' : 'CON FALLOS'} (${rows.filter((r) => r.estado === 'success').length}/${rows.length} en success)`);
process.exit(ok ? 0 : 1);
