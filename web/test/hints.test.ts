// Pistas del panel de problemas: los mensajes comunes del log tienen pista y nombran lo que falló.
import { describe, expect, it } from 'vitest';
import { hintFor } from '../src/lib/hints';

describe('hintFor', () => {
  it('nombra el comando, paquete, imagen o clave que falló', () => {
    expect(hintFor('Undefined control sequence. l.28 ...Ver la \\tabla')).toContain('el comando \\tabla');
    expect(hintFor("LaTeX Error: File `bookstabs.sty' not found.")).toContain('paquete bookstabs');
    expect(hintFor("LaTeX Error: File `figuras/mapa.png' not found.")).toContain('La imagen figuras/mapa.png');
    expect(hintFor("Citation 'knuth1984' on page 2 undefined on input line 22.")).toContain('knuth1984');
    expect(hintFor('Missing $ inserted.')).toContain('$...$');
  });

  it('sin pista para lo que no reconoce', () => {
    expect(hintFor('Package babel Info: Hyphen rules for spanish loaded.')).toBeNull();
  });
});
