import { z } from 'zod';
import { RATE_LIMITS, config, features, log } from '@jisr/core';
import { audit, pruneRateLimits, repo, withTenant } from '@jisr/db';
import { createCaseTask } from '@jisr/integrations';
import { validatedTask } from '../lib/task-kit';
import { dashboardCaseUrl } from '../lib/case-context';

/** Twilio delivery receipts. Used to show a broadcast as delivered, not just sent. */
export const deliveryStatus = validatedTask({
  id: 'delivery.status',
  schema: z.object({ providerSid: z.string().max(128), status: z.string().max(32) }),
  run: async ({ providerSid, status }) => {
    const companyId = config.DEFAULT_COMPANY_ID;
    if (!companyId) return { updated: false as const };

    const updated = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const message = await r.messageByProviderSid(providerSid);
      if (!message) return false;
      await r.updateMessage(message.id, { status });
      return true;
    });

    if (['failed', 'undelivered'].includes(status)) {
      log.warn('whatsapp_delivery_failed', { providerSid, status });
    }
    return { updated };
  },
});

/** C9. Mirror a routed case as a task in Ambiguous. Flagged off by default. */
export const ambiguousMirror = validatedTask({
  id: 'ambiguous.mirror',
  schema: z.object({ companyId: z.string().uuid(), caseId: z.string().uuid() }),
  run: async ({ companyId, caseId }) => {
    if (!features.ambiguousTasks) return { mirrored: false as const };

    const row = await withTenant(companyId, ({ tx }) => repo(companyId, tx).caseById(caseId));
    // A speak-up case is never mirrored: the mirror is outside our redaction path.
    if (!row || row.isSpeakup) return { mirrored: false as const };

    const result = await createCaseTask({
      casePublicId: row.publicId,
      title: `${row.category ?? 'case'} (${row.severity ?? 'medium'})`,
      summaryEn: row.summaryEn ?? '',
      dashboardUrl: dashboardCaseUrl(row.publicId),
    });

    return { mirrored: result.ok, externalRef: result.externalRef };
  },
});

/** Housekeeping. Fixed rate-limit windows leave rows behind. */
export const dailyMaintenance = validatedTask({
  id: 'maintenance.daily',
  schema: z.object({}),
  run: async () => {
    const oldest = RATE_LIMITS.audioSecondsPerWorker(0).windowSeconds * 1000 * 3;
    await pruneRateLimits(new Date(Date.now() - oldest));
    await audit({ event: 'maintenance_ran', details: { prunedBefore: oldest } });
    return { pruned: true as const };
  },
});
