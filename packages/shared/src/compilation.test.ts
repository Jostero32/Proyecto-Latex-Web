import { describe, expect, it } from 'vitest';
import { ENGINES, isEngine } from './compilation';

describe('isEngine', () => {
  it.each([...ENGINES])('acepta %s', (value) => {
    expect(isEngine(value)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['mayúsculas', 'XeLaTeX'],
    ['latex', 'latex'],
    ['vacío', ''],
    ['con espacio', 'xelatex '],
    ['null', null],
    ['undefined', undefined],
    ['número', 1],
    ['objeto', {}],
    ['propiedad heredada', 'constructor'],
  ])('rechaza %s', (_name, value) => {
    expect(isEngine(value)).toBe(false);
  });
});
