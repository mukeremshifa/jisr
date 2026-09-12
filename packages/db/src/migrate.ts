import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';

/**
 * Migration runner. Connects as `jisr_migrator` (DATABASE_URL_MIGRATOR), applies
 * the Drizzle migrations, then applies the hand-written `sql/` files in order,
 * roles and row-level security, which Drizzle does not generate.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', 'migrations');
const sqlFolder = join(here, '..', 'sql');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL_MIGRATOR (or DATABASE_URL) is required to migrate');
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder });
    process.stdout.write('drizzle migrations applied\n');

    const files = (await readdir(sqlFolder).catch(() => [])).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const body = await readFile(join(sqlFolder, file), 'utf8');
      await sql.unsafe(body);
      process.stdout.write(`applied ${file}\n`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
