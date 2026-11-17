// Configuración de la CLI de Prisma (migraciones y generación). Es configuración de herramientas, no
// de la app: la app lee DATABASE_URL en src/config.ts.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://latexweb:latexweb@127.0.0.1:5432/latexweb',
  },
});
