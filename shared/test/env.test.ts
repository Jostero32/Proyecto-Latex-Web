import { describe, expect, it } from 'vitest';
import { ConfigError, envPositiveInteger, envPositiveNumber, envSize } from '../src/env';

describe('envPositiveInteger', () => {
  it('usa el fallback si falta o está vacía', () => {
    expect(envPositiveInteger({}, 'X', 7)).toBe(7);
    expect(envPositiveInteger({ X: '' }, 'X', 7)).toBe(7);
  });
  it('lee un entero positivo', () => {
    expect(envPositiveInteger({ X: '42' }, 'X', 7)).toBe(42);
  });
  it.each(['0', '-3', '1.5', 'abc', '1e400'])('rechaza %j', (value) => {
    expect(() => envPositiveInteger({ X: value }, 'X', 7)).toThrow(ConfigError);
  });
});

describe('envPositiveNumber', () => {
  it('usa el fallback si falta o está vacía', () => {
    expect(envPositiveNumber({}, 'X', 1.5)).toBe(1.5);
    expect(envPositiveNumber({ X: '' }, 'X', 1.5)).toBe(1.5);
  });
  it('admite decimales', () => {
    expect(envPositiveNumber({ X: '0.5' }, 'X', 1)).toBe(0.5);
  });
  it.each(['0', '-1', 'abc', 'Infinity', 'NaN'])('rechaza %j', (value) => {
    expect(() => envPositiveNumber({ X: value }, 'X', 1)).toThrow(ConfigError);
  });
});

describe('envSize', () => {
  it('usa el fallback si falta o está vacía', () => {
    expect(envSize({}, 'X', '256m')).toBe('256m');
    expect(envSize({ X: '' }, 'X', '256m')).toBe('256m');
  });
  it.each(['512k', '256m', '1g'])('acepta %s', (value) => {
    expect(envSize({ X: value }, 'X', '1m')).toBe(value);
  });
  it.each(['0m', '256', 'm', '1.5g', '256M', '1t', '-1m'])('rechaza %j', (value) => {
    expect(() => envSize({ X: value }, 'X', '1m')).toThrow(ConfigError);
  });
});
