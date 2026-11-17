// Diálogos de Mis proyectos: nuevo proyecto, importar zip y renombrar. Cada uno llama a la API y
// muestra el error en lenguaje humano.
import { useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { errorMessage, isApiError } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useCreateProject, useImportProject, useUpdateProject } from './api';

// Igual que MAX_NAME_LENGTH del server.
const NAME_MAX = 120;

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const create = useCreateProject();
  const navigate = useNavigate();
  const valid = name.trim().length > 0 && name.trim().length <= NAME_MAX;
  const close = () => {
    setName('');
    create.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Nuevo proyecto"
      footer={
        <>
          <Button onClick={close}>Cancelar</Button>
          <Button variant="primary" type="submit" form="new-project" disabled={!valid || create.isPending}>
            {create.isPending ? 'Creando…' : 'Crear proyecto'}
          </Button>
        </>
      }
    >
      {create.isError && <Notice tone="error" title="No pudimos crear el proyecto">{errorMessage(create.error)}</Notice>}
      <form
        id="new-project"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) create.mutate(name.trim(), { onSuccess: (project) => navigate(`/proyectos/${project.id}`) });
        }}
      >
        <TextField
          label="Nombre del proyecto"
          data-autofocus
          value={name}
          maxLength={NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          placeholder="Por ejemplo: Tesis de maestría"
          hint="Arranca con un main.tex de plantilla. Después podés subir más archivos."
        />
      </form>
    </Dialog>
  );
}

function importError(error: unknown): { title: string; text: string } {
  if (isApiError(error, 'too_many_files')) {
    return { title: 'El zip trae demasiados archivos.', text: 'El máximo es 500. Probá quitar los .aux, .log y otros archivos que genera LaTeX.' };
  }
  if (isApiError(error, 'project_too_large') || isApiError(error, 'file_too_large') || isApiError(error, 'payload_too_large')) {
    return { title: 'El zip es demasiado grande.', text: 'El máximo es 200 MB en total y 50 MB por archivo. Probá achicar las imágenes o sacar videos.' };
  }
  if (isApiError(error, 'invalid_zip') || isApiError(error, 'invalid_path')) {
    return {
      title: 'No pudimos abrir ese zip.',
      text: 'Puede estar dañado o traer enlaces simbólicos o rutas raras. Probá volver a comprimir la carpeta del proyecto.',
    };
  }
  return { title: 'No pudimos importar el zip.', text: errorMessage(error) };
}

export function ImportZipDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const importZip = useImportProject();
  const navigate = useNavigate();
  const close = () => {
    setFile(null);
    setName('');
    setDragging(false);
    importZip.reset();
    onClose();
  };
  const choose = (chosen: File | null | undefined) => {
    if (!chosen) return;
    setFile(chosen);
    importZip.reset();
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  };
  const failure = importZip.isError ? importError(importZip.error) : null;
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Importar un zip"
      width="md"
      footer={
        <>
          <Button onClick={close}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={!file || importZip.isPending}
            onClick={() =>
              file &&
              importZip.mutate(
                { file, ...(name.trim() ? { name: name.trim() } : {}) },
                { onSuccess: (project) => navigate(`/proyectos/${project.id}`) },
              )
            }
          >
            {importZip.isPending ? 'Importando…' : 'Importar'}
          </Button>
        </>
      }
    >
      {failure && (
        <Notice tone="error" title={failure.title}>
          {failure.text}
        </Notice>
      )}
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-2.5 rounded-xl border-[1.5px] border-dashed px-5 py-8 text-text ${
          dragging ? 'border-accent bg-accent-soft' : 'border-border-input bg-bg'
        }`}
      >
        <Icon name={file ? 'zip' : 'upload'} size={28} strokeWidth={1.6} className="text-accent-text" />
        {dragging ? (
          <span className="text-base font-semibold">Soltalo para importarlo</span>
        ) : file ? (
          <>
            <span className="max-w-full truncate text-base font-semibold">{file.name}</span>
            <span className="text-sm text-muted">{formatBytes(file.size)} · tocá para elegir otro</span>
          </>
        ) : (
          <>
            <span className="text-base font-semibold">Arrastrá el .zip acá</span>
            <span className="text-sm text-muted">o tocá para elegirlo de tu computadora</span>
          </>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => choose(event.target.files?.[0])}
      />
      <TextField
        label="Nombre del proyecto"
        labelNote="(opcional)"
        placeholder="Si lo dejás vacío, usamos el nombre del zip"
        maxLength={NAME_MAX}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <p className="m-0 text-[13px] leading-normal text-muted">Hasta 500 archivos, 200 MB en total y 50 MB por archivo.</p>
    </Dialog>
  );
}

export function RenameProjectDialog({ id, name, open, onClose }: { id: string; name: string; open: boolean; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const update = useUpdateProject(id);
  const valid = value.trim().length > 0 && value.trim().length <= NAME_MAX;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Renombrar proyecto"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="rename-project" disabled={!valid || update.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      {update.isError && <Notice tone="error" title="No pudimos renombrarlo">{errorMessage(update.error)}</Notice>}
      <form
        id="rename-project"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) update.mutate({ name: value.trim() }, { onSuccess: onClose });
        }}
      >
        <TextField label="Nombre del proyecto" data-autofocus value={value} maxLength={NAME_MAX} onChange={(event) => setValue(event.target.value)} />
      </form>
    </Dialog>
  );
}
