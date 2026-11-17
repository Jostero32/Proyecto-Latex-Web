// Configuración de drizzle-kit (solo para generar migraciones: `pnpm db:generate`). No se conecta a
// la base: compara el esquema con la última instantánea de drizzle/.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
});
