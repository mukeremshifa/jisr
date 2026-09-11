import { z } from 'zod';
import {
  broadcastTranslateSystem,
  broadcastTranslateUser,
  callLLM,
  translationSchema,
  WORKER_MESSAGE_PROMPT_VERSION,
} from '@jisr/ai';
import { ackPrompt, config, languageOf, log, sanitizeText } from '@jisr/core';
import { audit, repo, withTenant } from '@jisr/db';
import {
  buildBroadcastAckCard,
  buildBroadcastPreview,
  fga,
  slackTransport,
} from '@jisr/integrations';
import { chargeTokens } from '../lib/budget';
import { sendToWorker } from '../lib/outbound';
import { trigger, validatedTask } from '../lib/task-kit';
import { outboundQueue } from '../queues';

/**
 * C4 — broadcasts.
 *
 * One English message becomes one voice note per worker, in that worker's own
 * language. Nothing is sent until a human sees every translation and presses
 * Send: `broadcast.compose` only drafts, `broadcast.decide` is the human click,
 * and `broadcast.deliver` does the fan-out.
 */

export const broadcastCompose = validatedTask({
  id: 'broadcast.compose',
  schema: z.object({
    source: z.enum(['slack', 'dashboard']),
    slackChannelId: z.string().max(64),
    slackUserId: z.string().max(64),
    textEn: z.string().min(1).max(600),
    /** The dashboard sends its own company and author, Slack resolves them here. */
    companyId: z.string().uuid().optional(),
    staffId: z.string().uuid().optional(),
    siteIds: z.array(z.string().uuid()).optional(),
  }),
  run: async (payload) => {
    const textEn = sanitizeText(payload.textEn, 600);
    if (!textEn) return { composed: false as const };

    const resolved = await resolveAuthorAndSites(payload);
    if (!resolved) {
      log.warn('broadcast_author_unresolved', { source: payload.source });
      return { composed: false as const, reason: 'unknown author' };
    }
    const { companyId, staffId, siteIds } = resolved;

    // FGA: a supervisor may broadcast to their own sites, HR and ops to all.
    const allowedSiteIds = await fga.allowedSiteIds(fga.userRef(staffId), siteIds);
    if (allowedSiteIds.length === 0) {
      await audit({
        event: 'fga_denied',
        severity: 'warn',
        companyId,
        actor: staffId,
        details: { relation: 'can_view_cases', action: 'broadcast', requested: siteIds.length },
      });
      return { composed: false as const, reason: 'not allowed' };
    }

    const workers = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).activeWorkersForSites(allowedSiteIds),
    );
    if (workers.length === 0) return { composed: false as const, reason: 'no workers' };

    // One translation per distinct language, not per worker.
    const languages = [...new Set(workers.map((w) => w.language))];
    const translations: Array<{ language: string; text: string }> = [];

    for (const language of languages) {
      if (language === 'en') {
        translations.push({ language, text: `${textEn} ${ackPrompt('en')}` });
        continue;
      }
      try {
        const result = await callLLM({
          task: `${WORKER_MESSAGE_PROMPT_VERSION}:broadcast`,
          system: broadcastTranslateSystem(),
          user: broadcastTranslateUser({ language, textEn }),
          schema: translationSchema,
          schemaName: 'broadcast_translation',
          maxTokens: 400,
          temperature: 0.1,
        });
        await chargeTokens(companyId, result.tokensUsed);
        translations.push({
          language,
          // The acknowledgement line is appended from a fixed table, so every
          // worker is asked for an ack in exactly the same words.
          text: `${result.data.textOriginal} ${ackPrompt(language)}`,
        });
      } catch (error) {
        // A language we cannot translate is shown in the preview as English, so
        // the human sending it can see the gap rather than discover it later.
        log.error('broadcast_translation_failed', { language, error });
        translations.push({ language, text: `${textEn} ${ackPrompt(language)}` });
      }
    }

    const broadcast = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).createBroadcast({
        createdByStaffId: staffId,
        textEn,
        siteIds: allowedSiteIds,
        translations,
      }),
    );

    const siteNames = await withTenant(companyId, async ({ tx }) => {
      const rows = await repo(companyId, tx).sites();
      return rows.filter((s) => allowedSiteIds.includes(s.id)).map((s) => s.name);
    });

    const preview = buildBroadcastPreview({
      broadcastId: broadcast.id,
      textEn,
      translations: translations.map((t) => ({ languageName: languageOf(t.language).name, text: t.text })),
      recipientCount: workers.length,
      siteNames,
    });

    const channelId = payload.slackChannelId || config.SLACK_DEFAULT_CHANNEL_ID;
    if (channelId) {
      const ref = await slackTransport().post(channelId, preview);
      await withTenant(companyId, ({ tx }) =>
        repo(companyId, tx).updateBroadcast(broadcast.id, {
          slackChannelId: ref.channelId,
          slackMessageTs: ref.messageTs,
        }),
      );
    }

    log.info('broadcast_composed', {
      broadcastPublicId: broadcast.publicId,
      languages: languages.length,
      recipients: workers.length,
    });

    return { composed: true as const, broadcastId: broadcast.id, recipients: workers.length };
  },
});

/** The human click. Send fans out; Cancel leaves the record with no deliveries. */
export const broadcastDecide = validatedTask({
  id: 'broadcast.decide',
  schema: z.object({
    broadcastId: z.string().uuid(),
    decision: z.enum(['send', 'cancel']),
    slackUserId: z.string().max(64).optional(),
    staffId: z.string().uuid().optional(),
    channelId: z.string().max(64).optional(),
    messageTs: z.string().max(64).optional(),
    companyId: z.string().uuid().optional(),
  }),
  run: async (payload) => {
    const companyId = payload.companyId ?? (await companyForBroadcast(payload.broadcastId));
    if (!companyId) return { decided: false as const };

    const broadcast = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).broadcastById(payload.broadcastId),
    );
    if (!broadcast || broadcast.status !== 'previewed') {
      return { decided: false as const, reason: 'not awaiting a decision' };
    }

    if (payload.decision === 'cancel') {
      await withTenant(companyId, ({ tx }) =>
        repo(companyId, tx).updateBroadcast(broadcast.id, { status: 'cancelled' }),
      );
      await audit({ event: 'broadcast_cancelled', companyId, subject: broadcast.publicId });
      return { decided: true as const, sent: false };
    }

    const workers = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).activeWorkersForSites(broadcast.target.siteIds),
    );

    await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.updateBroadcast(broadcast.id, { status: 'sending', sentAt: new Date() });
      for (const worker of workers) {
        await r.createDelivery({ broadcastId: broadcast.id, workerId: worker.id, language: worker.language });
      }
    });

    await audit({
      event: 'broadcast_sent',
      companyId,
      actor: payload.staffId ?? payload.slackUserId ?? null,
      subject: broadcast.publicId,
      details: { recipients: workers.length, sites: broadcast.target.siteIds.length },
    });

    // Fan out one task per worker, idempotent per (broadcast, worker), on a
    // queue limited to five at a time.
    for (const worker of workers) {
      await trigger(
        'broadcast.deliver',
        { companyId, broadcastId: broadcast.id, workerId: worker.id },
        { idempotencyKey: `${broadcast.id}:${worker.id}` },
      );
    }

    await trigger('broadcast.updateCard', { companyId, broadcastId: broadcast.id });
    await trigger(
      'broadcast.remind',
      { companyId, broadcastId: broadcast.id, round: 1 },
      { delay: `${config.DEMO_SLA_MINUTES}m`, idempotencyKey: `remind:${broadcast.id}:1` },
    );

    return { decided: true as const, sent: true, recipients: workers.length };
  },
});

export const broadcastDeliver = validatedTask({
  id: 'broadcast.deliver',
  schema: z.object({
    companyId: z.string().uuid(),
    broadcastId: z.string().uuid(),
    workerId: z.string().uuid(),
  }),
  queue: outboundQueue,
  retry: { maxAttempts: 3 },
  run: async ({ companyId, broadcastId, workerId }) => {
    const loaded = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      return { broadcast: await r.broadcastById(broadcastId), worker: await r.workerById(workerId) };
    });
    if (!loaded.broadcast || !loaded.worker) return { delivered: false as const };

    const language = loaded.worker.language;
    const translation =
      loaded.broadcast.translations.find((t) => t.language === language) ??
      loaded.broadcast.translations.find((t) => t.language === 'en');
    if (!translation) return { delivered: false as const, reason: 'no translation' };

    const sent = await sendToWorker({
      companyId,
      workerId,
      textOriginal: translation.text,
      textEn: loaded.broadcast.textEn,
      language,
    });

    await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).updateDelivery(broadcastId, workerId, {
        status: sent.providerSid ? 'sent' : 'failed',
        providerSid: sent.providerSid,
      }),
    );

    return { delivered: Boolean(sent.providerSid) };
  },
});

/** An inbound "OK" within 24 hours marks the delivery and refreshes the card. */
export const broadcastAck = validatedTask({
  id: 'broadcast.ack',
  schema: z.object({
    companyId: z.string().uuid(),
    workerId: z.string().uuid(),
    broadcastId: z.string().uuid(),
  }),
  run: async ({ companyId, workerId, broadcastId }) => {
    const updated = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).updateDelivery(broadcastId, workerId, {
        status: 'acked',
        ackedAt: new Date(),
      }),
    );
    if (!updated) return { acked: false as const };

    await trigger('broadcast.updateCard', { companyId, broadcastId });
    return { acked: true as const };
  },
});

export const broadcastUpdateCard = validatedTask({
  id: 'broadcast.updateCard',
  schema: z.object({ companyId: z.string().uuid(), broadcastId: z.string().uuid() }),
  run: async ({ companyId, broadcastId }) => {
    const loaded = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const broadcast = await r.broadcastById(broadcastId);
      if (!broadcast) return null;
      const deliveries = await r.deliveries(broadcastId);
      const pending: string[] = [];
      for (const delivery of deliveries) {
        if (delivery.ackedAt) continue;
        const worker = await r.workerById(delivery.workerId);
        if (worker) pending.push(worker.publicRef);
      }
      return { broadcast, deliveries, pending };
    });
    if (!loaded?.broadcast.slackChannelId || !loaded.broadcast.slackMessageTs) {
      return { updated: false as const };
    }

    const acked = loaded.deliveries.filter((d) => d.ackedAt).length;
    const card = buildBroadcastAckCard({
      broadcastPublicId: loaded.broadcast.publicId,
      textEn: loaded.broadcast.textEn,
      total: loaded.deliveries.length,
      acked,
      languages: [...new Set(loaded.broadcast.translations.map((t) => languageOf(t.language).name))],
      pending: loaded.pending,
      status: acked === loaded.deliveries.length ? 'Everyone has heard it.' : 'Waiting for acknowledgements.',
    });

    await slackTransport().update(
      { channelId: loaded.broadcast.slackChannelId, messageTs: loaded.broadcast.slackMessageTs },
      card,
    );
    return { updated: true as const };
  },
});

/**
 * Round 1 sends one reminder to whoever has not acknowledged. Round 2 stops
 * messaging workers and hands the list to their supervisor instead.
 */
export const broadcastRemind = validatedTask({
  id: 'broadcast.remind',
  schema: z.object({
    companyId: z.string().uuid(),
    broadcastId: z.string().uuid(),
    round: z.number().int().min(1).max(2),
  }),
  run: async ({ companyId, broadcastId, round }) => {
    const loaded = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const broadcast = await r.broadcastById(broadcastId);
      if (!broadcast) return null;
      return { broadcast, deliveries: await r.deliveries(broadcastId) };
    });
    if (!loaded) return { reminded: 0 };

    const unacked = loaded.deliveries.filter((d) => !d.ackedAt);
    if (unacked.length === 0) return { reminded: 0 };

    if (round === 1) {
      for (const delivery of unacked) {
        const translation =
          loaded.broadcast.translations.find((t) => t.language === delivery.language) ??
          loaded.broadcast.translations.find((t) => t.language === 'en');
        if (!translation) continue;

        await sendToWorker({
          companyId,
          workerId: delivery.workerId,
          textOriginal: translation.text,
          textEn: loaded.broadcast.textEn,
          language: delivery.language,
        });
        await withTenant(companyId, ({ tx }) =>
          repo(companyId, tx).updateDelivery(broadcastId, delivery.workerId, {
            remindersSent: delivery.remindersSent + 1,
          }),
        );
      }

      await trigger(
        'broadcast.remind',
        { companyId, broadcastId, round: 2 },
        { delay: `${config.DEMO_SLA_MINUTES}m`, idempotencyKey: `remind:${broadcastId}:2` },
      );
      return { reminded: unacked.length };
    }

    // Round 2: escalate to a human rather than message workers again.
    const names = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const refs: string[] = [];
      for (const delivery of unacked) {
        const worker = await r.workerById(delivery.workerId);
        if (worker) refs.push(worker.publicRef);
      }
      return refs;
    });

    const channelId = loaded.broadcast.slackChannelId ?? config.SLACK_ESCALATION_CHANNEL_ID;
    if (channelId && loaded.broadcast.slackMessageTs) {
      await slackTransport().postThreadReply(
        { channelId, messageTs: loaded.broadcast.slackMessageTs },
        {
          text: `Still not acknowledged after two reminders: ${names.join(', ')}. Please check on them in person.`,
        },
      );
    }

    await audit({
      event: 'broadcast_unacked_escalated',
      severity: 'warn',
      companyId,
      subject: loaded.broadcast.publicId,
      details: { pending: names.length },
    });

    return { reminded: 0, escalated: names.length };
  },
});

// ---------------------------------------------------------------------------

async function resolveAuthorAndSites(payload: {
  source: 'slack' | 'dashboard';
  slackChannelId: string;
  slackUserId: string;
  companyId?: string;
  staffId?: string;
  siteIds?: string[];
}): Promise<{ companyId: string; staffId: string; siteIds: string[] } | null> {
  if (payload.source === 'dashboard') {
    if (!payload.companyId || !payload.staffId) return null;
    const siteIds =
      payload.siteIds ??
      (await withTenant(payload.companyId, async ({ tx }) =>
        (await repo(payload.companyId!, tx).sites()).map((s) => s.id),
      ));
    return { companyId: payload.companyId, staffId: payload.staffId, siteIds };
  }

  // Slack: the channel identifies the site, and the site identifies the company.
  // A command run outside a site channel falls back to the author's own sites.
  const companyId = payload.companyId ?? config.DEFAULT_COMPANY_ID;
  if (!companyId) return null;

  return withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const staffRow = await r.staffBySlackUserId(payload.slackUserId);
    if (!staffRow) return null;

    const site = payload.slackChannelId ? await r.siteBySlackChannel(payload.slackChannelId) : null;
    const siteIds = site ? [site.id] : (await r.sites()).map((s) => s.id);
    return { companyId, staffId: staffRow.id, siteIds };
  });
}

async function companyForBroadcast(broadcastId: string): Promise<string | null> {
  const companyId = config.DEFAULT_COMPANY_ID;
  if (!companyId) return null;
  const found = await withTenant(companyId, ({ tx }) => repo(companyId, tx).broadcastById(broadcastId));
  return found ? companyId : null;
}
