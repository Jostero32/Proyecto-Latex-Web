// Diálogos del editor: ajustes del proyecto, nuevo archivo, buscar archivo (Ctrl+P) y log completo.
import { useState, type KeyboardEvent } from 'react';
import { normalizeProjectPath, type Engine, type PathRejectReason, type ProjectFile } from '@latexweb/shared';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SelectField, TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { fileIcon } from './tree';
import { ENGINE_LABELS } from './PdfPane';

const ENGINE_HELP: Record<Engine, string> = {
  pdflatex: 'El más común y el más rápido. Sirve para casi todos los documentos.',
  xelatex: 'Para usar las fuentes instaladas (OpenType) y escrituras no latinas.',
  lualatex: 'Como XeLaTeX, y además permite programar en Lua. Es el más lento.',
};

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  name: string;
  isOwner: boolean;
  mainFile: string;
  engine: Engine;
  texFiles: string[];
  onSave: (settings: { mainFile: string; engine: Engine }) => void;
}

export function SettingsDialog({ open, onClose, name, isOwner, mainFile, engine, texFiles, onSave }: SettingsDialogProps) {
  const [main, setMain] = useState(mainFile);
  const [chosen, setChosen] = useState(engine);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ajustes del proyecto"
      width="md"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave({ mainFile: main, engine: chosen });
              onClose();
            }}
          >
            Guardar
          </Button>
        </>
      }
    >
      <TextField label="Nombre" defaultValue={name} disabled={!isOwner} hint={isOwner ? undefined : 'Solo el dueño cambia el nombre.'} />
      <SelectField label="Documento principal" value={main} onChange={(event) => setMain(event.target.value)} hint="El archivo que se compila.">
        {texFiles.map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
      </SelectField>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1.5 p-0 text-sm font-semibold">Motor</legend>
        {(Object.keys(ENGINE_LABELS) as Engine[]).map((value) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border-[1.5px] p-3 ${chosen === value ? 'border-accent bg-accent-soft/50' : 'border-border'}`}
          >
            <input type="radio" name="engine" value={value} checked={chosen === value} onChange={() => setChosen(value)} className="mt-1 accent-[var(--c-accent)]" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">{ENGINE_LABELS[value]}</span>
              <span className="text-[13px] leading-snug text-muted">{ENGINE_HELP[value]}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}

const PATH_ERRORS: Record<PathRejectReason, string> = {
  empty: 'Escribí un nombre.',
  too_long: 'La ruta es demasiado larga (máximo 255 caracteres).',
  absolute: 'La ruta no puede empezar con / ni con una letra de unidad.',
  forbidden_character: 'Tiene un carácter que no se permite, como \\ : * ? " < > |.',
  invalid_segment: 'Una parte de la ruta no es válida, como .. o un nombre vacío.',
  too_deep: 'Demasiadas carpetas anidadas (máximo 10).',
  reserved_name: 'Ese nombre está reservado en Windows (CON, NUL, COM1…).',
};

export function NewFileDialog({ open, onClose, existing, onCreate }: { open: boolean; onClose: () => void; existing: string[]; onCreate: (path: string) => void }) {
  const [path, setPath] = useState('');
  const [touched, setTouched] = useState(false);
  const check = normalizeProjectPath(path);
  const taken = check.ok && existing.some((p) => p.toLowerCase() === check.path.toLowerCase());
  const error = !touched ? null : !check.ok ? PATH_ERRORS[check.reason] : taken ? 'Ya hay un archivo con ese nombre.' : null;
  const close = () => {
    setPath('');
    setTouched(false);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Nuevo archivo"
      footer={
        <>
          <Button onClick={close}>Cancelar</Button>
          <Button variant="primary" type="submit" form="new-file">
            Crear archivo
          </Button>
        </>
      }
    >
      <form
        id="new-file"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (check.ok && !taken) {
            onCreate(check.path);
            close();
          }
        }}
      >
        <TextField
          label="Nombre o ruta"
          autoFocus
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="capitulos/conclusiones.tex"
          error={error}
          hint={error ? 'Por ejemplo: capitulos/conclusiones.tex' : 'Para crearlo en una carpeta, escribí la ruta: capitulos/conclusiones.tex'}
        />
      </form>
    </Dialog>
  );
}

/** Paleta para buscar un archivo por nombre: coincidencia resaltada, flechas y Enter. */
export function FileSearchDialog({ open, onClose, files, onOpen }: { open: boolean; onClose: () => void; files: ProjectFile[]; onOpen: (path: string) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const q = query.trim().toLowerCase();
  const results = files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 12);
  const close = () => {
    setQuery('');
    setActive(0);
    onClose();
  };
  const choose = (path: string) => {
    onOpen(path);
    close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + results.length) % Math.max(results.length, 1));
    }
    if (event.key === 'Enter' && results[active]) choose(results[active].path);
  };
  return (
    <Dialog open={open} onClose={close} title="Buscar archivo" width="md">
      <div className="relative">
        <Icon name="search" className="pointer-events-none absolute top-[13px] left-[13px] text-muted" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="file-search-results"
          aria-activedescendant={results[active] ? `file-result-${active}` : undefined}
          aria-label="Nombre del archivo"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Escribí parte del nombre"
          className="h-11 w-full rounded-md border-[1.5px] border-border-input bg-surface pr-3 pl-10 text-[15px] text-text"
        />
      </div>
      <ul id="file-search-results" role="listbox" aria-label="Archivos" className="-mx-2 m-0 flex max-h-[320px] list-none flex-col overflow-auto p-0">
        {results.length === 0 && <li className="px-3 py-2 text-sm text-muted">Ningún archivo coincide con “{query.trim()}”.</li>}
        {results.map((file, index) => {
          const name = file.path.slice(file.path.lastIndexOf('/') + 1);
          return (
            <li
              key={file.path}
              id={`file-result-${index}`}
              role="option"
              aria-selected={index === active}
              onClick={() => choose(file.path)}
              onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 ${index === active ? 'bg-accent-soft' : ''}`}
            >
              <Icon name={fileIcon(file.path)} size={16} className="text-faint" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">
                  <Highlight text={name} query={q} />
                </span>
                <span className="truncate font-mono text-xs text-muted">{file.path}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-accent/20 text-inherit">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

const SAMPLE_LOG = `This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2026) (preloaded format=pdflatex)
entering extended mode
(./main.tex
LaTeX2e <2025-11-01>
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Document Class: article 2024/06/29 v1.4n Standard LaTeX document class
)
(/usr/local/texlive/2026/texmf-dist/tex/generic/babel/babel.sty
Package babel Info: Hyphen rules for spanish loaded.
)

! LaTeX Error: File \`bookstabs.sty' not found.

l.5 \\usepackage
                {bookstabs}^^M
! Undefined control sequence.
l.28 donde $A$ está en t/ha por año. Ver la \\tabla
                                                   {res}.
Output written on output.pdf (2 pages, 48213 bytes).`;

export function LogDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Log completo" subtitle="output.log · última compilación" width="lg" footer={<Button icon="download">Descargar log</Button>}>
      <pre className="m-0 max-h-[50vh] overflow-auto rounded-lg bg-bg p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text">{SAMPLE_LOG}</pre>
    </Dialog>
  );
}
