import { describe, expect, it } from 'vitest';
import { hashPassword, isValidPassword, normalizeEmail, PASSWORD_MAX, verifyPassword } from './passwords';

describe('normalizeEmail', () => {
  it('normaliza a minúsculas y sin espacios', () => {
    expect(normalizeEmail('  Ana@Ejemplo.COM ')).toBe('ana@ejemplo.com');
  });

  it.each(['', 'sin-arroba', 'a@b', 'a b@c.d', 'a@b@c.d', 'a\n@b.c', 42, null, `${'a'.repeat(250)}@b.cd`])(
    'rechaza %j',
    (email) => expect(normalizeEmail(email)).toBeNull(),
  );
});

describe('contraseñas', () => {
  it('exige entre 10 y 256 caracteres', () => {
    expect(isValidPassword('x'.repeat(9))).toBe(false);
    expect(isValidPassword('x'.repeat(10))).toBe(true);
    expect(isValidPassword('x'.repeat(PASSWORD_MAX))).toBe(true);
    expect(isValidPassword('x'.repeat(PASSWORD_MAX + 1))).toBe(false);
    expect(isValidPassword(undefined)).toBe(false);
  });

  it('hashea con argon2id y verifica', async () => {
    const hash = await hashPassword('una clave larga');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'una clave larga')).toBe(true);
    expect(await verifyPassword(hash, 'otra clave larga')).toBe(false);
  });

  it('un hash corrupto nunca autentica (sin lanzar)', async () => {
    expect(await verifyPassword('no-es-un-hash', 'una clave larga')).toBe(false);
  });
});
