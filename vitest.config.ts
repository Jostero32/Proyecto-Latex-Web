import { defineConfig } from 'vitest/config';

// `pnpm test`: todos los tests de <app>/test/ menos la compilación real con Docker
// (`pnpm test:compile`, vitest.compile.config.ts). Necesita postgres, redis y minio levantados
// (`docker compose up -d postgres redis minio`). Ver CLAUDE.md, "Tests".
export default defineConfig({
  test: {
    include: ['{server,compiler,shared,web}/test/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'compiler/test/compile*.test.ts'],
    // Crea y migra la base latexweb_test.
    globalSetup: ['server/test/global-setup.ts'],
    // Un archivo a la vez: los tests del server comparten la base de datos.
    fileParallelism: false,
  },
});
