import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_ALLOWED_ORIGINS,
  hostName,
  isAllowedHost,
  isAllowedOrigin,
  type RequestGuardOptions,
} from './request-guard';

const options: RequestGuardOptions = { allowedOrigins: DEFAULT_ALLOWED_ORIGINS, allowedHosts: DEFAULT_ALLOWED_HOSTS };

describe('hostName', () => {
  it.each<[string | undefined, string | null]>([
    ['127.0.0.1:3000', '127.0.0.1'],
    ['LOCALHOST', 'localhost'],
    ['[::1]:3000', '[::1]'],
    ['[::1]', '[::1]'],
    ['evil.com:80', 'evil.com'],
    ['', null],
    [undefined, null],
    ['[::1', null],
    ['a b', null],
    ['host:puerto', null],
    ['127.0.0.1:99999999', null],
  ])('%j → %j', (input, expected) => {
    expect(hostName(input)).toBe(expected);
  });
});

describe('isAllowedHost (valores por defecto)', () => {
  it.each<[string | undefined, boolean]>([
    ['127.0.0.1:3000', true],
    ['127.0.0.1', true],
    ['localhost:5173', true],
    ['LocalHost', true],
    ['[::1]:3000', true],
    ['evil.com', false],
    ['evil.com:3000', false],
    ['127.0.0.1.evil.com', false],
    ['localhost.evil.com', false],
    ['', false],
    [undefined, false],
    ['[::1', false],
  ])('%j → %j', (host, expected) => {
    expect(isAllowedHost(host, options)).toBe(expected);
  });
});

describe('isAllowedOrigin (valores por defecto)', () => {
  it.each<[string | undefined, boolean]>([
    [undefined, true],
    ['http://localhost:5173', true],
    ['http://localhost:5173/', true],
    ['http://127.0.0.1:5173', true],
    ['HTTP://LOCALHOST:5173', true],
    ['null', false],
    ['http://evil.com', false],
    ['http://localhost:5174', false],
    ['https://localhost:5173', false],
    ['http://localhost:5173.evil.com', false],
    ['', false],
  ])('%j → %j', (origin, expected) => {
    expect(isAllowedOrigin(origin, options)).toBe(expected);
  });
});
