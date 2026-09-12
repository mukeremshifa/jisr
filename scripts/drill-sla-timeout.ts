import { config } from '@jisr/core';
import { closeDb, repo, withTenant } from '@jisr/db';

/**
 * Failure drill 3. Force an SLA breach.
 *
 * Moves an open case's SLA into the past so the next check escalates it. The
 * live path is a waitpoint token timing out, which cannot be hurried; this drill
 * makes the same state visible for the video and for the dashboard's "past SLA"
 * list.
 *
 *   pnpm tsx scripts/drill-sla-timeout.ts JS-7F3K
 */

async function main(): Promise<void> {
  const companyId = config.DEFAULT_COMPANY_ID;
  if (!companyId) throw new Error('DEFAULT_COMPANY_ID must be set');

  const publicId = process.argv[2];
  if (!publicId) throw new Error('usage: drill-sla-timeout.ts <case public id>');

  const result = await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const row = await r.caseByPublicId(publicId);
    if (!row) return null;
    const updated = await r.updateCase(row.id, {
      slaDueAt: new Date(Date.now() - 60_000),
      firstResponseAt: null,
    });
    await r.addEvent({
      caseId: row.id,
      type: 'drill_sla_forced',
      actorKind: 'system',
      payload: { by: 'scripts/drill-sla-timeout.ts' },
    });
    return updated;
  });

  if (!result) throw new Error(`case ${publicId} not found`);

  process.stdout.write('\nDrill: SLA breach\n\n');
  process.stdout.write(`${result.publicId} is now past its SLA with no first response.\n`);
  process.stdout.write('Expected: the escalation channel gets the card, and the worker hears\n');
  process.stdout.write('that their case is now with a senior manager.\n');
  process.stdout.write(`Configured SLA: ${config.DEMO_SLA_MINUTES} minute(s).\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
