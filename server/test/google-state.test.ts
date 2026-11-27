import { Redis } from 'ioredis';
import { expect, it } from 'vitest';
import { createRedisGoogleStates, googleHash, googleRandom } from '../src/features/auth/google';

it('Redis vincula state al navegador, lo consume atómicamente y aplica TTL', async () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379');
  const states = createRedisGoogleStates(redis);
  const state = googleRandom();
  const secondState = googleRandom();
  const transaction = { browserHash: googleHash('browser'), nonce: 'nonce', verifier: 'verifier', returnPath: '/' };
  const key = (value: string) => `latexweb-google:${googleHash(value)}`;
  try {
    await states.put(state, transaction);
    expect(await redis.ttl(key(state))).toBeGreaterThan(590);
    expect(await states.consume(state, googleHash('another-browser'))).toBeNull();
    const results = await Promise.all([states.consume(state, transaction.browserHash), states.consume(state, transaction.browserHash)]);
    expect(results.filter(Boolean)).toEqual([transaction]);
    await states.put(secondState, transaction);
    await redis.pexpire(key(secondState), 0);
    expect(await states.consume(secondState, transaction.browserHash)).toBeNull();
  } finally {
    await redis.del(key(state), key(secondState));
    redis.disconnect();
  }
});
