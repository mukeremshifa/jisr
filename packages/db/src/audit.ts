import { log, type SecurityEvent } from '@jisr/core';
import { getDb, type DbOrTx } from './client';
import { withTenant } from './tenant';
import { auditLog } from './schema';

/**
 * Security events go two places: `audit_log` (insert-only for the app role) and
 * structured logs. Both, always. A log line can be lost, a row cannot, and a
 * row is useless if nobody is watching the log stream.
 */
export interface AuditInput {
  event: SecurityEvent | (string & {});
  severity?: 'info' | 'warn' | 'critical';
  companyId?: string | null;
  /** Who did it: a staff id, `worker:<uuid>`, `agent`, or `system`. Never a phone number. */
  actor?: string | null;
  /** What it was done to: a case public id, a worker public ref, a phone HMAC. */
  subject?: string | null;
  details?: Record<string, unknown>;
}

export async function audit(input: AuditInput, tx?: DbOrTx): Promise<void> {
  const severity = input.severity ?? 'info';
  const row = {
    companyId: input.companyId ?? null,
    event: input.event,
    severity,
    actor: input.actor ?? null,
    subject: input.subject ?? null,
    details: input.details ?? {},
  };

  const logFields = { event: input.event, actor: row.actor, subject: row.subject, ...row.details };
  if (severity === 'critical') log.error(`audit:${input.event}`, logFields);
  else if (severity === 'warn') log.warn(`audit:${input.event}`, logFields);
  else log.info(`audit:${input.event}`, logFields);

  try {
    // Resolved inside the try on purpose: as a default argument, `getDb()` runs
    // before this block and a missing DATABASE_URL would take down the very
    // request this call is describing.
    // audit_log has FORCE ROW LEVEL SECURITY: outside a tenant transaction the
    // insert must run inside withTenant, or Postgres silently refuses the row.
    if (tx) await tx.insert(auditLog).values(row);
    else if (row.companyId) await withTenant(row.companyId, ({ tx: t }) => t.insert(auditLog).values(row));
    else await getDb().insert(auditLog).values(row);
  } catch (error) {
    // An audit write must never take down the request it is describing, but it
    // must be loud when it fails.
    log.error('audit_write_failed', { event: input.event, error });
  }
}
