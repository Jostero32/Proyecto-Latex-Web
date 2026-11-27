import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { presenceColor, remoteSelection } from '../src/features/editor/presence';

describe('presencia sin CSS controlado por el cliente', () => {
  it('descarta CSS arbitrario y limita los colores a la paleta', () => {
    expect(presenceColor('#C2410C')).toBe(1);
    expect(presenceColor('red; position:fixed; inset:0')).toBe(0);
    expect(presenceColor({ color: '#C2410C' })).toBe(0);
  });
  it('resuelve posiciones relativas tras cambios y rechaza cursores de otro archivo o inválidos', () => {
    const doc = new Y.Doc();
    const text = doc.getText('a');
    text.insert(0, 'hola mundo');
    const cursor = {
      anchor: Y.createRelativePositionFromTypeIndex(text, 5),
      head: Y.createRelativePositionFromTypeIndex(text, 10),
    };
    text.insert(0, '¡');
    expect(remoteSelection(text, cursor)).toEqual({ anchor: 6, head: 11 });
    expect(remoteSelection(doc.getText('b'), cursor)).toBeNull();
    expect(remoteSelection(text, { anchor: null, head: {} })).toBeNull();
    doc.destroy();
  });
});
