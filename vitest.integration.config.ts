import { defineConfig } from 'vitest/config';

// Tests de integración con Docker real (`pnpm test:integration`). Lentos: no forman parte de
// `pnpm test`. Se saltan si no hay Docker o falta la imagen, salvo con LATEXWEB_REQUIRE_DOCKER=1.
export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.integration.test.ts'],
    // Un archivo a la vez: cada compilación usa 1 CPU y hasta 1 GB.
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
