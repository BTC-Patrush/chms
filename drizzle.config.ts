import { defineConfig } from 'drizzle-kit';

// Migrations are generated into ./drizzle and applied only as an explicit operator step,
// connected as chms_owner (ADR-006, ADR-007). `drizzle-kit push` is never used.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['chms'],
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env.CHMS_MIGRATION_DATABASE_URL ?? '' },
});
