// Presencia Yjs con clases y hojas nonced de CodeMirror, sin atributos style de terceros.
import { StateEffect, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { yRemoteSelectionsTheme } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { COLLABORATOR_COLORS } from '../../lib/collaborator-colors';

const refreshPresence = StateEffect.define<null>();

/** Un estado remoto no es confiable: descarta posiciones malformadas o de otro archivo. */
export function remoteSelection(text: Y.Text, raw: unknown): { anchor: number; head: number } | null {
  if (!text.doc || typeof raw !== 'object' || raw === null) return null;
  try {
    const cursor = raw as { anchor: Parameters<typeof Y.createRelativePositionFromJSON>[0]; head: Parameters<typeof Y.createRelativePositionFromJSON>[0] };
    const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.anchor), text.doc);
    const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), text.doc);
    if (!anchor || !head || anchor.type !== text || head.type !== text) return null;
    return { anchor: anchor.index, head: head.index };
  } catch {
    return null;
  }
}

export function presenceColor(raw: unknown): number {
  const index = COLLABORATOR_COLORS.findIndex((color) => color === raw);
  return index < 0 ? 0 : index;
}

class RemoteCaret extends WidgetType {
  constructor(readonly color: number, readonly name: string) { super(); }
  override eq(other: RemoteCaret): boolean { return this.color === other.color && this.name === other.name; }
  override toDOM(view: EditorView): HTMLElement {
    const caret = view.dom.ownerDocument.createElement('span');
    caret.className = `cm-ySelectionCaret pliego-peer-${this.color}`;
    const label = view.dom.ownerDocument.createElement('span');
    label.className = 'cm-ySelectionInfo';
    label.textContent = this.name;
    caret.append('\u2060', label, '\u2060');
    return caret;
  }
}

const colorsTheme = EditorView.baseTheme(Object.fromEntries(COLLABORATOR_COLORS.flatMap((color, index) => [
  [`.cm-ySelectionCaret.pliego-peer-${index}`, { backgroundColor: color, borderColor: color }],
  [`.cm-ySelection.pliego-peer-${index}`, { backgroundColor: `${color}38` }],
])));

export function collaboratorPresence(text: Y.Text, awareness: Awareness): Extension {
  return [yRemoteSelectionsTheme, colorsTheme, ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    private destroyed = false;
    private pending = false;
    private changed = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      if (this.pending || ![...added, ...updated, ...removed].some((id) => id !== awareness.clientID)) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        if (!this.destroyed) this.view.dispatch({ effects: refreshPresence.of(null) });
      });
    };
    constructor(private view: EditorView) {
      awareness.on('change', this.changed);
      this.draw();
    }
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged || update.focusChanged) {
        const selection = this.view.state.selection.main;
        const cursor = this.view.hasFocus ? {
          anchor: Y.createRelativePositionFromTypeIndex(text, selection.anchor),
          head: Y.createRelativePositionFromTypeIndex(text, selection.head),
        } : null;
        const current = awareness.getLocalState()?.cursor ?? null;
        if (awareness.getLocalState() && JSON.stringify(current) !== JSON.stringify(cursor)) {
          awareness.setLocalStateField('cursor', cursor);
        }
      }
      this.draw();
    }
    private draw() {
      const ranges: Range<Decoration>[] = [];
      for (const [id, state] of awareness.getStates()) {
        if (id === awareness.clientID) continue;
        const position = remoteSelection(text, state.cursor);
        if (!position || Math.max(position.anchor, position.head) > this.view.state.doc.length) continue;
        const color = presenceColor(state.user?.color);
        const name = typeof state.user?.name === 'string' ? state.user.name.slice(0, 200) : 'Colaborador';
        const from = Math.min(position.anchor, position.head);
        const to = Math.max(position.anchor, position.head);
        if (from < to) ranges.push(Decoration.mark({ class: `cm-ySelection pliego-peer-${color}` }).range(from, to));
        ranges.push(Decoration.widget({ widget: new RemoteCaret(color, name), side: position.head > position.anchor ? -1 : 1 }).range(position.head));
      }
      this.decorations = Decoration.set(ranges, true);
    }
    destroy() {
      this.destroyed = true;
      awareness.off('change', this.changed);
      if (remoteSelection(text, awareness.getLocalState()?.cursor)) awareness.setLocalStateField('cursor', null);
    }
  }, { decorations: (plugin) => plugin.decorations })];
}
