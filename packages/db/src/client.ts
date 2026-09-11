import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ConfigError, config } from '@jisr/core';
import * as schema from './schema';

/**
 * One pool per process. The app connects as `jisr_app`, which has no DDL rights
 * and INSERT-only on audit_log (see migrations/9999_roles.sql).
 */

let sqlClient: postgres.Sql | undefined;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getSql(): postgres.Sql {
  if (sqlClient) return sqlClient;
  if (!config.DATABASE_URL) throw new ConfigError('DATABASE_URL is required');
  sqlClient = postgres(config.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // Cloud Run scales to many small instances; prepared statements across
    // a pooled connection (Neon pgbouncer) are not safe, so turn them off.
    prepare: false,
    onnotice: () => {},
  });
  return sqlClient;
}

export function getDb() {
  if (!dbInstance) dbInstance = drizzle(getSql(), { schema });
  return dbInstance;
}

export type Db = ReturnType<typeof getDb>;
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
    dbInstance = undefined;
  }
}

export { schema };
