import { sql } from 'drizzle-orm';
import { getDb, type Db, type DbOrTx } from './client';

/**
 * Tenant isolation, mandatory layer.
 *
 * Every query runs inside `withTenant(companyId, ...)`, which:
 *  1. opens a transaction,
 *  2. sets `app.company_id` for the transaction so Postgres row-level security
 *     policies (migrations/9998_rls.sql) can enforce the same boundary,
 *  3. hands the caller a repository already bound to that company.
 *
 * The repository never takes a companyId from a request body. It comes from the
 * session or the roster lookup, and nowhere else.
 */

export interface TenantContext {
  companyId: string;
  tx: DbOrTx;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T>(
  companyId: string,
  fn: (ctx: TenantContext) => Promise<T>,
  db: Db = getDb(),
): Promise<T> {
  // Validated before it reaches `set_config`: this is the one place a tenant id
  // becomes part of a session setting, so it must be a UUID and nothing else.
  if (!UUID_RE.test(companyId)) throw new Error('withTenant requires a UUID companyId');

  return db.transaction(async (tx) => {
    // Parameterized: set_config is a function call, not string interpolation.
    await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
    return fn({ companyId, tx });
  });
}

/**
 * For the few reads that legitimately cross tenants: the Twilio webhook has only
 * a phone number and must find which company the worker belongs to. It reads one
 * indexed column and returns ids, nothing else.
 */
export async function withoutTenant<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return fn(getDb());
}
