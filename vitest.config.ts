import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Un solo proyecto: ningún paquete necesita configuración propia todavía. (Con `projects` por
    // glob de carpetas, el `exclude` de la raíz no se hereda.) Cuando web necesite jsdom, separar.
    include: ['apps/*/src/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.ts'],
    // Los tests con Docker real van aparte: `pnpm test:integration` (vitest.integration.config.ts).
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    passWithNoTests: true,
  },
});
