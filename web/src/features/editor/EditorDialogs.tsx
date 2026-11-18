// Diálogos del editor: ajustes del proyecto, nuevo archivo, buscar archivo (Ctrl+P) y log completo.
import { useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { normalizeProjectPath, type Engine, type PathRejectReason, type ProjectFile } from '@latexweb/shared';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SelectField, TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { download, errorMessage, fetchApi, isApiError } from '../../lib/api';
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
  saving: boolean;
  onSave: (settings: { name?: string; mainFile: string; engine: Engine }) => void;
}

export function SettingsDialog({ open, onClose, name, isOwner, mainFile, engine, texFiles, saving, onSave }: SettingsDialogProps) {
  const [newName, setNewName] = useState(name);
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
            disabled={saving || (isOwner && !newName.trim())}
            onClick={() => onSave({ ...(isOwner && newName.trim() !== name ? { name: newName.trim() } : {}), mainFile: main, engine: chosen })}
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </Button>
        </>
      }
    >
      <TextField
        label="Nombre"
        value={newName}
        maxLength={120}
        onChange={(event) => setNewName(event.target.value)}
        disabled={!isOwner}
        hint={isOwner ? undefined : 'Solo el dueño cambia el nombre.'}
      />
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
          data-autofocus
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

/** Renombrar o mover: la ruta completa, con carpetas. */
export function RenameFileDialog({ path, existing, onClose, onRename }: { path: string; existing: string[]; onClose: () => void; onRename: (path: string) => void }) {
  const [value, setValue] = useState(path);
  const check = normalizeProjectPath(value);
  const taken = check.ok && check.path.toLowerCase() !== path.toLowerCase() && existing.some((p) => p.toLowerCase() === check.path.toLowerCase());
  const error = !check.ok ? PATH_ERRORS[check.reason] : taken ? 'Ya hay un archivo con ese nombre.' : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Renombrar o mover"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="rename-file" disabled={Boolean(error) || (check.ok && check.path === path)}>
            Guardar
          </Button>
        </>
      }
    >
      <form
        id="rename-file"
        onSubmit={(event) => {
          event.preventDefault();
          if (check.ok && !taken) onRename(check.path);
        }}
      >
        <TextField
          label="Ruta"
          data-autofocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          error={error}
          hint="Para moverlo, cambiá la carpeta: figuras/diagrama.png"
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
          data-autofocus
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

/** El log de la compilación: se baja al abrir el diálogo. */
export function LogDialog({ open, onClose, logUrl, compiled }: { open: boolean; onClose: () => void; logUrl: string | null; compiled: boolean }) {
  const log = useQuery({
    queryKey: ['log', logUrl],
    enabled: open && logUrl !== null,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (!logUrl) return '';
      return (await fetchApi(logUrl, signal)).text();
    },
  });
  const status = !compiled
    ? 'Todavía no compilaste este proyecto.'
    : !logUrl
      ? 'Esta compilación no dejó log.'
      : log.isPending
        ? 'Cargando el log…'
        : log.isError
          ? isApiError(log.error, 'expired')
            ? 'El log venció: volvé a compilar para verlo.'
            : errorMessage(log.error)
          : null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Log completo"
      subtitle="output.log · última compilación"
      width="lg"
      footer={
        <Button icon="download" disabled={!logUrl} onClick={() => logUrl && download(logUrl, 'output.log')}>
          Descargar log
        </Button>
      }
    >
      {status ? (
        <p className="m-0 rounded-lg bg-bg p-4 text-sm text-muted">{status}</p>
      ) : (
        <pre className="m-0 max-h-[50vh] overflow-auto rounded-lg bg-bg p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text">{log.data}</pre>
      )}
    </Dialog>
  );
}
