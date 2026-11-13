import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests unitarios: al lado de su archivo, en src/. Los de integración (test/integration/)
    // se corren aparte con `pnpm test:integration` (vitest.integration.config.ts). Ver CLAUDE.md.
    // Un solo proyecto: ningún paquete necesita configuración propia todavía. Cuando web
    // necesite jsdom, separar en proyectos.
    include: ['apps/*/src/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
