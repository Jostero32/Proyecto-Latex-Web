import { defineConfig } from 'vitest/config';

// `pnpm test:compile`: compilaciones reales en Docker con la imagen de TeX Live. Lentas.
export default defineConfig({
  test: {
    include: ['compiler/test/compile*.test.ts'],
    // Un archivo a la vez: cada compilación usa 1 CPU y hasta 1 GB.
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
