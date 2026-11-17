// Diálogos de Mis proyectos: nuevo proyecto, importar zip y renombrar.
import { useRef, useState, type DragEvent } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { formatBytes } from '../../lib/format';

// Igual que MAX_NAME_LENGTH del server.
const NAME_MAX = 120;

export function NewProjectDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  const valid = name.trim().length > 0 && name.trim().length <= NAME_MAX;
  const close = () => {
    setName('');
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
          <Button variant="primary" type="submit" form="new-project" disabled={!valid}>
            Crear proyecto
          </Button>
        </>
      }
    >
      <form
        id="new-project"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onCreate(name.trim());
        }}
      >
        <TextField
          label="Nombre del proyecto"
          autoFocus
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

type ImportError = 'invalido' | 'muchos' | 'grande';

const IMPORT_ERRORS: Record<ImportError, { title: string; text: string }> = {
  invalido: {
    title: 'No pudimos abrir ese zip.',
    text: 'Puede estar dañado o traer enlaces simbólicos o rutas raras. Probá volver a comprimir la carpeta del proyecto.',
  },
  muchos: {
    title: 'El zip trae demasiados archivos.',
    text: 'Trae 812 y el máximo es 500. Probá quitar los .aux, .log y otros archivos que genera LaTeX.',
  },
  grande: {
    title: 'El zip es demasiado grande.',
    text: 'El máximo es 200 MB en total y 50 MB por archivo. Probá achicar las imágenes o sacar videos.',
  },
};

export function ImportZipDialog({ open, onClose, demoError }: { open: boolean; onClose: () => void; demoError?: ImportError | null }) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const close = () => {
    setFile(null);
    setDragging(false);
    onClose();
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Importar un zip"
      width="md"
      footer={
        <>
          <Button onClick={close}>Cancelar</Button>
          <Button variant="primary" disabled={!file} onClick={close}>
            Importar
          </Button>
        </>
      }
    >
      {demoError && (
        <Notice tone="error" title={IMPORT_ERRORS[demoError].title}>
          {IMPORT_ERRORS[demoError].text}
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
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      <TextField label="Nombre del proyecto" labelNote="(opcional)" placeholder="Si lo dejás vacío, usamos el nombre del zip" />
      <p className="m-0 text-[13px] leading-normal text-muted">Hasta 500 archivos, 200 MB en total y 50 MB por archivo.</p>
    </Dialog>
  );
}

export function RenameProjectDialog({ name, open, onClose }: { name: string; open: boolean; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const valid = value.trim().length > 0 && value.trim().length <= NAME_MAX;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Renombrar proyecto"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={!valid} onClick={onClose}>
            Guardar
          </Button>
        </>
      }
    >
      <TextField label="Nombre del proyecto" autoFocus value={value} maxLength={NAME_MAX} onChange={(event) => setValue(event.target.value)} />
    </Dialog>
  );
}
