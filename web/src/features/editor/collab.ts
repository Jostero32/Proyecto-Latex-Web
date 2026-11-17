// Colaboración en vivo de un proyecto: un Y.Doc y un HocuspocusProvider por proyecto abierto. El texto de
// cada archivo es `files[fileId]` (Y.Text); la presencia viaja por awareness. La cookie de sesión va sola
// con el WebSocket (mismo origen, por el proxy de Vite).
//
// El server cierra un documento con un mensaje CLOSE: `permissions-changed` (cambió el rol o te quitaron)
// o `document-too-large`. En los dos casos se arma una sesión nueva, que vuelve a pasar por los permisos
// y trae el estado del server.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { colorFor } from '../../components/Avatar';

export type CollabStatus = 'connecting' | 'connected' | 'disconnected';
export type CollabNotice = 'permisos' | 'doc-grande' | null;

/** Otra persona (o yo en otra pestaña) en el proyecto. */
export interface Peer {
  userId: string;
  /** El nombre de la cuenta (null si no tiene). */
  name: string | null;
  email: string;
  color: string;
  /** Id del archivo abierto. */
  fileId: string | null;
}

export interface CollabSnapshot {
  doc: Y.Doc | null;
  awareness: Awareness | null;
  status: CollabStatus;
  synced: boolean;
  /** Cambios locales que el server todavía no confirmó. */
  unsynced: number;
  /** El server me dejó en solo lectura (lector). */
  readOnly: boolean;
  notice: CollabNotice;
  /** Al reconectar, el server negó el acceso (me quitaron o borraron el proyecto). */
  denied: boolean;
  peers: Peer[];
  /** Cambia cada vez que se agrega o se quita un archivo del documento. */
  filesVersion: number;
}

export interface CollabUser {
  id: string;
  name: string | null;
  email: string;
}

const EMPTY: CollabSnapshot = {
  doc: null,
  awareness: null,
  status: 'connecting',
  synced: false,
  unsynced: 0,
  readOnly: false,
  notice: null,
  denied: false,
  peers: [],
  filesVersion: 0,
};

interface AwarenessUser {
  id?: unknown;
  realName?: unknown;
  email?: unknown;
  color?: unknown;
  fileId?: unknown;
}

class ProjectCollab {
  private snapshot: CollabSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private provider: HocuspocusProvider | null = null;
  private fileId: string | null = null;
  private onServerNotice: (notice: string) => void = () => {};

  constructor(
    private readonly projectId: string,
    private readonly user: CollabUser,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private set(changes: Partial<CollabSnapshot>) {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }

  connect() {
    if (this.provider) return;
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`,
      name: `project:${this.projectId}`,
      document: doc,
      onStatus: ({ status }) => this.set({ status: status as CollabStatus }),
      onSynced: ({ state }) => this.set({ synced: state }),
      onUnsyncedChanges: ({ number }) => this.set({ unsynced: number }),
      onAuthenticated: ({ scope }) => this.set({ readOnly: scope === 'readonly', denied: false }),
      onAuthenticationFailed: () => this.set({ denied: true }),
      onStateless: ({ payload }) => {
        try {
          const message = JSON.parse(payload) as { type?: unknown };
          if (typeof message.type === 'string') this.onServerNotice(message.type);
        } catch {
          // Un mensaje que no es JSON no es nuestro.
        }
      },
      onClose: ({ event }) => {
        if (event.reason === 'permissions-changed') this.restart('permisos');
        else if (event.reason === 'document-too-large') this.restart('doc-grande');
      },
    });
    doc.getMap('files').observe(() => this.set({ filesVersion: this.snapshot.filesVersion + 1 }));
    const awareness = provider.awareness;
    if (awareness) {
      awareness.setLocalStateField('user', this.localUser());
      awareness.on('change', () => this.set({ peers: this.readPeers(awareness) }));
    }
    this.provider = provider;
    this.set({ ...EMPTY, notice: this.snapshot.notice, doc, awareness });
  }

  destroy() {
    const provider = this.provider;
    this.provider = null;
    if (!provider) return;
    provider.destroy();
    provider.document.destroy();
  }

  /** Sesión nueva: vuelve a pasar por los permisos y trae el estado del server. */
  private restart(notice: CollabNotice) {
    // Fuera del manejador del mensaje: el provider todavía lo está procesando.
    setTimeout(() => {
      this.destroy();
      this.set({ notice });
      this.connect();
    }, 0);
  }

  /** Quién recibe los avisos del server (`files-changed`, `project-changed`). */
  setNoticeHandler(handler: (notice: string) => void) {
    this.onServerNotice = handler;
  }

  dismissNotice() {
    this.set({ notice: null });
  }

  /** El archivo abierto, para que los demás vean dónde estoy. */
  setFile(fileId: string | null) {
    this.fileId = fileId;
    this.provider?.awareness?.setLocalStateField('user', this.localUser());
  }

  private localUser() {
    const color = colorFor(this.user.id);
    return {
      id: this.user.id,
      // y-codemirror.next muestra `name` junto al cursor; `realName` es el de la cuenta (para las iniciales).
      name: this.user.name ?? this.user.email,
      realName: this.user.name,
      email: this.user.email,
      color,
      // y-codemirror.next usa colorLight para la selección remota.
      colorLight: `${color}38`,
      fileId: this.fileId,
    };
  }

  private readPeers(awareness: Awareness): Peer[] {
    const peers = new Map<string, Peer>();
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      const user = (state as { user?: AwarenessUser }).user;
      if (!user || typeof user.id !== 'string' || peers.has(user.id)) continue;
      peers.set(user.id, {
        userId: user.id,
        name: typeof user.realName === 'string' ? user.realName : null,
        email: typeof user.email === 'string' ? user.email : '',
        color: typeof user.color === 'string' ? user.color : colorFor(user.id),
        fileId: typeof user.fileId === 'string' ? user.fileId : null,
      });
    }
    return [...peers.values()];
  }
}

export interface UseCollab extends CollabSnapshot {
  setFile: (fileId: string | null) => void;
  dismissNotice: () => void;
}

/** La sesión de colaboración del proyecto: se conecta al montar y se cierra al salir. */
export function useCollab(projectId: string, user: CollabUser, onServerNotice: (notice: string) => void): UseCollab {
  const { id, name, email } = user;
  const collab = useMemo(() => new ProjectCollab(projectId, { id, name, email }), [projectId, id, name, email]);
  useEffect(() => {
    collab.setNoticeHandler(onServerNotice);
  }, [collab, onServerNotice]);
  useEffect(() => {
    collab.connect();
    return () => collab.destroy();
  }, [collab]);
  const snapshot = useSyncExternalStore(collab.subscribe, collab.getSnapshot);
  return useMemo(
    () => ({ ...snapshot, setFile: (fileId: string | null) => collab.setFile(fileId), dismissNotice: () => collab.dismissNotice() }),
    [snapshot, collab],
  );
}
