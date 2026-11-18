import { defineConfig } from 'vitest/config';

// `vitest run`: los tests del worker sin Docker. `vitest run --mode compile` (`pnpm test:compile`):
// compilaciones reales en Docker con la imagen de TeX Live, lentas.
export default defineConfig(({ mode }) =>
  mode === 'compile'
    ? {
        test: {
          include: ['test/compile*.test.ts'],
          // Un archivo a la vez: cada compilación usa 1 CPU y hasta 1 GB.
          fileParallelism: false,
          testTimeout: 180_000,
        },
      }
    : {
        test: {
          include: ['test/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'test/compile*.test.ts'],
        },
      },
);
