import { defineConfig } from 'vitest/config';

// Tests del server de punta a punta: necesitan postgres, redis y minio levantados
// (`docker compose up -d postgres redis minio`). Ver CLAUDE.md, "Tests".
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Crea y migra la base latexweb_test y vacía el bucket de test.
    globalSetup: ['test/global-setup.ts'],
    // Un archivo a la vez: comparten la base de datos.
    fileParallelism: false,
  },
});
