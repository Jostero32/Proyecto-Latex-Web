import { defineConfig } from 'vitest/config';

// Tests de integración (`pnpm test:integration`): apps/*/test/integration/. Necesitan servicios
// externos (Docker, Redis…) o son lentos, así que no forman parte de `pnpm test`. Ver CLAUDE.md.
export default defineConfig({
  test: {
    include: ['apps/*/test/integration/**/*.test.ts'],
    // Un archivo a la vez: cada compilación usa 1 CPU y hasta 1 GB.
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
