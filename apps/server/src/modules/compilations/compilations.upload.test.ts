import { describe, expect, it } from 'vitest';
import { UploadError, validateUpload, type RawUpload } from './compilations.upload';

const file = (filename: string, text = 'x') => ({ filename, data: Buffer.from(text) });

function errorOf(raw: RawUpload): UploadError {
  try {
    validateUpload(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(UploadError);
    return error as UploadError;
  }
  throw new Error('se esperaba un UploadError');
}

describe('validateUpload', () => {
  it('sin archivos: no_files', () => {
    const error = errorOf({ files: [] });
    expect(error.code).toBe('no_files');
    expect(error.statusCode).toBe(400);
  });

  it.each(['../x.tex', '/etc/passwd', 'C:/x', 'a\\b.tex', 'con.tex', ''])('ruta inválida %j: invalid_path', (path) => {
    const error = errorOf({ files: [file('main.tex'), file(path)] });
    expect(error.code).toBe('invalid_path');
    expect(error.statusCode).toBe(400);
  });

  it.each(['latexmkrc', 'sub/LATEXMKRC', '.latexmkrc', '.git/config'])('%s se ignora', (path) => {
    const result = validateUpload({ files: [file('main.tex'), file(path)] });
    expect(result.ignoredFiles).toEqual([path]);
    expect(result.files.map((f) => f.path)).toEqual(['main.tex']);
  });

  it('si todos se ignoran: no_files', () => {
    expect(errorOf({ files: [file('latexmkrc'), file('.git/config')] }).code).toBe('no_files');
  });

  it('duplicado por mayúsculas: duplicate_path', () => {
    expect(errorOf({ files: [file('main.tex'), file('Main.TEX')] }).code).toBe('duplicate_path');
  });

  it('conflicto archivo/carpeta: duplicate_path', () => {
    expect(errorOf({ files: [file('main.tex'), file('a'), file('a/b.tex')] }).code).toBe('duplicate_path');
  });

  it('mainFile por defecto main.tex', () => {
    expect(validateUpload({ files: [file('main.tex')] }).mainFile).toBe('main.tex');
  });

  it('mainFile en subcarpeta', () => {
    const result = validateUpload({ files: [file('tesis/main.tex')], mainFile: 'tesis/main.tex' });
    expect(result.mainFile).toBe('tesis/main.tex');
  });

  it.each(['-e.tex', 'a$b.tex'])('mainFile inválido %s: invalid_main_file', (mainFile) => {
    // a$b.tex es una ruta válida de proyecto; -e.tex también.
    expect(errorOf({ files: [file('main.tex'), file(mainFile)], mainFile }).code).toBe('invalid_main_file');
  });

  it('mainFile ausente: main_file_missing', () => {
    const error = errorOf({ files: [file('otro.tex')] });
    expect(error.code).toBe('main_file_missing');
    expect(error.statusCode).toBe(400);
  });

  it('motor explícito válido', () => {
    expect(validateUpload({ files: [file('main.tex')], engine: 'lualatex' }).engine).toBe('lualatex');
  });

  it('motor explícito inválido: invalid_engine', () => {
    expect(errorOf({ files: [file('main.tex')], engine: 'latex' }).code).toBe('invalid_engine');
  });

  it('sin motor: comentario mágico del principal', () => {
    const result = validateUpload({ files: [file('main.tex', '% !TEX program = xelatex\n\\documentclass{article}')] });
    expect(result.engine).toBe('xelatex');
  });

  it('sin motor ni comentario: pdflatex', () => {
    expect(validateUpload({ files: [file('main.tex', '\\documentclass{article}')] }).engine).toBe('pdflatex');
  });

  it('motor explícito gana al comentario mágico', () => {
    const result = validateUpload({
      files: [file('main.tex', '% !TEX program = xelatex\n')],
      engine: 'lualatex',
    });
    expect(result.engine).toBe('lualatex');
  });

  it('normaliza rutas a NFC', () => {
    const nfd = 'cafe\u0301.tex';
    const result = validateUpload({ files: [file('main.tex'), file(nfd)] });
    expect(result.files.map((f) => f.path)).toContain('caf\u00e9.tex');
  });
});
