import { defineConfig } from 'drizzle-kit';

/**
 * DDL runs as `jisr_migrator`, never as the app role. `DATABASE_URL_MIGRATOR` is
 * the only place that role's credentials are used.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
