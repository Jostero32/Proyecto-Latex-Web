// Editor de LaTeX: CodeMirror 6 sobre el Y.Text del archivo (y-codemirror.next), con los cursores de los
// demás, deshacer por persona, búsqueda, marcas de error de la última compilación y saltos a una línea.
// Los colores salen de los tokens de Pliego (variables CSS), así sirve igual en claro y en oscuro.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { defaultKeymap } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { collaboratorPresence } from './presence';

/** Línea → texto a subrayar (el comando o paquete que falló). */
export type ErrorLines = Map<number, string | undefined>;

export type FormatAction = 'bold' | 'italic' | 'section' | 'list' | 'formula' | 'figure' | 'cite';

export interface LatexEditorHandle {
  format: (action: FormatAction) => void;
  focus: () => void;
}

interface LatexEditorProps {
  text: Y.Text;
  awareness: Awareness;
  readOnly: boolean;
  errors: ErrorLines;
  /** Línea a la que saltar; `key` cambia en cada pedido, aunque sea la misma línea. */
  jump: { line: number; key: number } | null;
  onCursor: (cursor: { line: number; column: number }) => void;
  label: string;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--c-surface)', color: 'var(--c-text)' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '22px' },
  '.cm-content': { padding: '8px 0 32px', caretColor: 'var(--c-text)' },
  '.cm-gutters': { backgroundColor: 'var(--c-surface)', color: 'var(--c-faint)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '40px', padding: '0 12px 0 0', fontSize: '12px' },
  '.cm-activeLine': { backgroundColor: 'var(--c-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--c-text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--c-text)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--c-accent-soft) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--c-surface-2)', outline: '1px solid var(--c-border-input)' },
  '.cm-searchMatch': { backgroundColor: 'var(--c-warning-soft)' },
  '.cm-panels': { backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', borderColor: 'var(--c-border)' },
  '.cm-panel input, .cm-panel button': { fontFamily: 'inherit', fontSize: '13px' },
  '.cm-error-gutter': { width: '20px' },
  '.cm-error-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-error)' },
  '.cm-error-token': { textDecoration: 'underline wavy var(--c-error)', textDecorationThickness: '1.5px', textUnderlineOffset: '4px' },
  '.cm-jump-line': { backgroundColor: 'var(--c-jump)', boxShadow: 'inset 0 1px 0 var(--c-accent), inset 0 -1px 0 var(--c-accent)' },
  // Cursores de los demás (y-codemirror.next): etiqueta siempre visible, con el nombre.
  '.cm-ySelectionInfo': { opacity: '1', fontFamily: "'Instrument Sans', sans-serif", fontSize: '11px', fontWeight: '600', padding: '0 6px', borderRadius: '4px 4px 4px 0', top: '-1.15em', color: '#fff' },
  '.cm-ySelectionCaret': { borderLeftWidth: '2px' },
});

const highlight = HighlightStyle.define([
  { tag: tags.tagName, color: 'var(--c-accent)' },
  { tag: tags.keyword, color: 'var(--c-math)' },
  { tag: tags.special(tags.variableName), color: 'var(--c-math)' },
  { tag: tags.number, color: 'var(--c-math)' },
  { tag: tags.bracket, color: 'var(--c-faint)' },
  { tag: tags.comment, color: 'var(--c-faint)', fontStyle: 'italic' },
]);

// Marcas de error: una por línea, con el texto a subrayar.
const setErrors = StateEffect.define<ErrorLines>();
const errorsField = StateField.define<ErrorLines>({
  create: () => new Map(),
  update: (value, tr) => tr.effects.reduce((current, effect) => (effect.is(setErrors) ? effect.value : current), value),
});

class ErrorMarker extends GutterMarker {
  override toDOM() {
    const span = document.createElement('span');
    span.title = 'Error en esta línea';
    span.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8zM9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>';
    return span;
  }
}
const errorMarker = new ErrorMarker();

const errorGutter = gutter({
  class: 'cm-error-gutter',
  lineMarker(view, line) {
    const number = view.state.doc.lineAt(line.from).number;
    return view.state.field(errorsField).has(number) ? errorMarker : null;
  },
  lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setErrors))),
});

const errorTokens = EditorView.decorations.compute([errorsField, 'doc'], (state) => {
  const builder = new RangeSetBuilder<Decoration>();
  const errors = state.field(errorsField);
  const lines = [...errors.keys()].filter((n) => n >= 1 && n <= state.doc.lines).sort((a, b) => a - b);
  for (const number of lines) {
    const token = errors.get(number);
    if (!token) continue;
    const line = state.doc.line(number);
    const at = line.text.indexOf(token);
    if (at >= 0) builder.add(line.from + at, line.from + at + token.length, Decoration.mark({ class: 'cm-error-token' }));
  }
  return builder.finish();
});

// Línea a la que se saltó (desde el panel de problemas o el PDF): resaltada hasta que se edite.
const setJump = StateEffect.define<number | null>();
const jumpField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setJump)) continue;
      if (effect.value === null) return Decoration.none;
      const line = tr.state.doc.line(Math.min(effect.value, tr.state.doc.lines));
      return Decoration.set([Decoration.line({ class: 'cm-jump-line' }).range(line.from)]);
    }
    return tr.docChanged ? Decoration.none : value.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Envuelve cada selección con `before` y `after` y deja seleccionado el texto de adentro. */
function wrap(view: EditorView, before: string, after: string): boolean {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const inner = state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: before + inner + after },
        range: EditorSelection.range(range.from + before.length, range.from + before.length + inner.length),
      };
    }),
  );
  view.focus();
  return true;
}

/** Inserta un bloque en una línea propia y deja el cursor en `cursorAt` (posición dentro del bloque). */
function insertBlock(view: EditorView, block: string, cursorAt: number): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const prefix = line.text.trim() ? '\n' : '';
  const from = line.text.trim() ? line.to : line.from;
  view.dispatch({ changes: { from, to: line.text.trim() ? from : line.to, insert: prefix + block }, selection: { anchor: from + prefix.length + cursorAt } });
  view.focus();
  return true;
}

export function applyFormat(view: EditorView, action: FormatAction): boolean {
  if (view.state.readOnly) return false;
  switch (action) {
    case 'bold':
      return wrap(view, '\\textbf{', '}');
    case 'italic':
      return wrap(view, '\\textit{', '}');
    case 'section':
      return wrap(view, '\\section{', '}');
    case 'formula':
      return wrap(view, '$', '$');
    case 'cite':
      return wrap(view, '\\cite{', '}');
    case 'list': {
      const block = '\\begin{itemize}\n  \\item \n\\end{itemize}';
      return insertBlock(view, block, block.indexOf('\\item ') + 6);
    }
    case 'figure': {
      const block = '\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=.8\\linewidth]{}\n  \\caption{}\n\\end{figure}';
      return insertBlock(view, block, block.indexOf('linewidth]{') + 11);
    }
  }
}

export const LatexEditor = forwardRef<LatexEditorHandle, LatexEditorProps>(function LatexEditor(
  { text, awareness, readOnly, errors, jump, onCursor, label },
  handle,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const onCursorRef = useRef(onCursor);
  useEffect(() => {
    onCursorRef.current = onCursor;
  });

  useImperativeHandle(handle, () => ({
    format: (action) => {
      if (view.current) applyFormat(view.current, action);
    },
    focus: () => view.current?.focus(),
  }));

  // Un EditorView por archivo: el Y.Text cambia al cambiar de pestaña.
  useEffect(() => {
    if (!host.current) return;
    const undoManager = new Y.UndoManager(text);
    const extensions: Extension[] = [
      EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ''),
      lineNumbers(),
      errorGutter,
      highlightActiveLineGutter(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      bracketMatching(),
      indentOnInput(),
      EditorView.lineWrapping,
      StreamLanguage.define(stex),
      syntaxHighlighting(highlight),
      errorsField,
      errorTokens,
      jumpField,
      theme,
      readOnlyCompartment.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      keymap.of([
        { key: 'Mod-b', run: (v) => applyFormat(v, 'bold') },
        { key: 'Mod-i', run: (v) => applyFormat(v, 'italic') },
        ...yUndoManagerKeymap,
        ...searchKeymap,
        ...defaultKeymap,
      ]),
      yCollab(text, null, { undoManager }),
      collaboratorPresence(text, awareness),
      EditorView.contentAttributes.of({ 'aria-label': label }),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursorRef.current({ line: line.number, column: head - line.from });
      }),
    ];
    const created = new EditorView({ parent: host.current, state: EditorState.create({ doc: text.toString(), extensions }) });
    view.current = created;
    return () => {
      created.destroy();
      undoManager.destroy();
      view.current = null;
    };
    // readOnly y label se aplican aparte, sin recrear el editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, awareness]);

  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly, text]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrors.of(errors) });
  }, [errors, text]);

  useEffect(() => {
    const current = view.current;
    if (!jump || !current) return;
    const line = current.state.doc.line(Math.max(1, Math.min(jump.line, current.state.doc.lines)));
    current.dispatch({
      selection: { anchor: line.from },
      effects: [setJump.of(line.number), EditorView.scrollIntoView(line.from, { y: 'center' })],
    });
    current.focus();
  }, [jump, text]);

  return <div ref={host} className="min-h-0 flex-1 overflow-hidden" />;
});
