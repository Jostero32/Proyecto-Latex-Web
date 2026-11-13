import { describe, expect, it } from 'vitest';
import { mapState } from './compilations.queue';

describe('mapState', () => {
  it.each([
    ['waiting', 'queued'],
    ['delayed', 'queued'],
    ['prioritized', 'queued'],
    ['waiting-children', 'queued'],
    ['active', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['unknown', null],
    ['otro', null],
  ])('%s -> %s', (input, expected) => {
    expect(mapState(input)).toBe(expected);
  });
});
