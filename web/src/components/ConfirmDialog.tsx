// Confirmación de acciones destructivas. El foco arranca en Cancelar. Con `confirmText`, hay que
// escribirlo para habilitar el botón (borrar un proyecto pide escribir su nombre).
import { useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { TextField } from './Field';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmText?: string;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel, confirmText }: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const close = () => {
    setTyped('');
    onClose();
  };
  const ready = confirmText === undefined || typed.trim() === confirmText;
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          <Button autoFocus onClick={close}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            disabled={!ready}
            onClick={() => {
              onConfirm();
              close();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[15px] leading-relaxed text-muted">{children}</div>
      {confirmText !== undefined && (
        <TextField
          label="Escribí el nombre para confirmar"
          hint={<span className="break-all">{confirmText}</span>}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
        />
      )}
    </Dialog>
  );
}
