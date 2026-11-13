import { describe, expect, it } from 'vitest';
import { COMPILE_QUEUE, SERVICE_NAMES } from './index';

describe('@latexweb/shared', () => {
  it('expone los nombres de servicio y la cola de compilación', () => {
    expect(SERVICE_NAMES).toEqual(['web', 'server', 'compiler']);
    expect(COMPILE_QUEUE).toBe('compile');
  });
});
