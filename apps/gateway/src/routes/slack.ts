import { Hono } from 'hono';
import { wait, tasks } from '@trigger.dev/sdk';
import { z } from 'zod';
import { CaseAction, log, sanitizeText } from '@jisr/core';
import { audit, findCaseBySlackMessage, repo, withTenant } from '@jisr/db';
import {
  buildEditHoursModal,
  buildRejectModal,
  buildReplyModal,
  fga,
  slackTransport,
  verifySlackSignature,
} from '@jisr/integrations';

/**
 * Slack interactivity, for the Web API transport.
 *
 * Slack gives us three seconds. So this route only verifies, authorizes and hands
 * off: it completes the case's waitpoint token (one API call) or triggers a task,
 * then returns 200. Nothing here waits on a model or on Twilio.
 *
 * When the CopilotKit Channels runtime is active it delivers the same interactions
 * through `onInteraction`, which calls the same `applyDecision` below.
 */

export const slackRoutes = new Hono();

const ButtonValue = z
  .object({
    caseId: z.string().uuid(),
    action: z.string().min(1).max(40),
    params: z.record(z.unknown()).default({}),
  })
  .strict();

const ModalValue = z
  .object({
    caseId: z.string().uuid().optional(),
    adjustmentId: z.string().uuid().optional(),
    /** Modals carry their tenant: a view_submission has no channel to resolve from. */
    companyId: z.string().uuid().optional(),
  })
  .passthrough();

slackRoutes.post('/slack/interactivity', async (c) => {
  const rawBody = await c.req.text();
  if (
    !verifySlackSignature({
      signature: c.req.header('x-slack-signature'),
      timestamp: c.req.header('x-slack-request-timestamp'),
      rawBody,
    })
  ) {
    await audit({ event: 'slack_signature_invalid', severity: 'warn', details: { path: '/slack/interactivity' } });
    return c.text('', 403);
  }

  const payloadRaw = new URLSearchParams(rawBody).get('payload');
  if (!payloadRaw) return c.text('', 400);

  let payload: SlackInteraction;
  try {
    payload = JSON.parse(payloadRaw) as SlackInteraction;
  } catch {
    return c.text('', 400);
  }

  // Respond fast; do the rest without holding Slack open.
  void handleInteraction(payload).catch((error: unknown) =>
    log.error('slack_interaction_failed', { type: payload.type, error }),
  );

  return c.text('', 200);
});

/** `/jisr broadcast <text>` — scoped to the channel's site. */
slackRoutes.post('/slack/commands', async (c) => {
  const rawBody = await c.req.text();
  if (
    !verifySlackSignature({
      signature: c.req.header('x-slack-signature'),
      timestamp: c.req.header('x-slack-request-timestamp'),
      rawBody,
    })
  ) {
    await audit({ event: 'slack_signature_invalid', severity: 'warn', details: { path: '/slack/commands' } });
    return c.text('', 403);
  }

  const form = new URLSearchParams(rawBody);
  const text = sanitizeText(form.get('text'), 600);
  const channelId = form.get('channel_id') ?? '';
  const slackUserId = form.get('user_id') ?? '';

  const [subcommand, ...rest] = text.split(/\s+/);
  if (subcommand !== 'broadcast' || rest.length === 0) {
    return c.json({
      response_type: 'ephemeral',
      text: 'Usage: `/jisr broadcast <message>` — I will show you every translation before anything is sent.',
    });
  }

  await tasks.trigger('broadcast.compose', {
    source: 'slack' as const,
    slackChannelId: channelId,
    slackUserId,
    textEn: rest.join(' '),
  });

  return c.json({
    response_type: 'ephemeral',
    text: 'Translating. I will post a preview here — nothing goes out until you press Send.',
  });
});

// ---------------------------------------------------------------------------

interface SlackInteraction {
  type: string;
  user?: { id?: string };
  trigger_id?: string;
  container?: { channel_id?: string; message_ts?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, unknown> } };
}

async function handleInteraction(payload: SlackInteraction): Promise<void> {
  if (payload.type === 'block_actions') return handleBlockAction(payload);
  if (payload.type === 'view_submission') return handleViewSubmission(payload);
}

async function handleBlockAction(payload: SlackInteraction): Promise<void> {
  const action = payload.actions?.[0];
  const actionId = action?.action_id ?? '';
  const slackUserId = payload.user?.id ?? '';
  const channelId = payload.container?.channel_id ?? payload.channel?.id ?? '';
  const messageTs = payload.container?.message_ts ?? payload.message?.ts ?? '';

  if (actionId.startsWith('jisr_case_action_')) {
    const parsed = ButtonValue.safeParse(safeJson(action?.value));
    if (!parsed.success) return;
    await applyDecision({
      caseId: parsed.data.caseId,
      actionName: parsed.data.action,
      params: parsed.data.params,
      slackUserId,
      channelId,
      messageTs,
    });
    return;
  }

  if (actionId === 'jisr_pay_edit_hours' || actionId === 'jisr_pay_reject') {
    const parsed = ModalValue.safeParse(safeJson(action?.value));
    if (!parsed.success || !parsed.data.adjustmentId || !parsed.data.caseId || !payload.trigger_id) return;

    const resolved = await resolveActor({ caseId: parsed.data.caseId, slackUserId, channelId, messageTs });
    if (!resolved) return;

    const adjustment = await withTenant(resolved.companyId, ({ tx }) =>
      repo(resolved.companyId, tx).payAdjustmentById(parsed.data.adjustmentId!),
    );
    if (!adjustment) return;

    const view =
      actionId === 'jisr_pay_edit_hours'
        ? buildEditHoursModal({
            adjustmentId: adjustment.id,
            caseId: parsed.data.caseId,
            companyId: resolved.companyId,
            currentHoursX100: adjustment.hoursX100,
          })
        : buildRejectModal({
            adjustmentId: adjustment.id,
            caseId: parsed.data.caseId,
            companyId: resolved.companyId,
          });

    await slackTransport().openModal(payload.trigger_id, view);
    return;
  }

  if (actionId === 'jisr_reply_freeform') {
    const parsed = ModalValue.safeParse(safeJson(action?.value));
    if (!parsed.success || !parsed.data.caseId || !payload.trigger_id) return;
    const resolved = await resolveActor({
      caseId: parsed.data.caseId,
      slackUserId,
      channelId,
      messageTs,
      ...(parsed.data.companyId ? { companyId: parsed.data.companyId } : {}),
    });
    if (!resolved) return;
    await slackTransport().openModal(
      payload.trigger_id,
      buildReplyModal(parsed.data.caseId, resolved.casePublicId, resolved.companyId),
    );
    return;
  }

  if (actionId === 'jisr_broadcast_send' || actionId === 'jisr_broadcast_cancel') {
    const value = safeJson(action?.value) as { broadcastId?: string } | null;
    if (!value?.broadcastId) return;
    await tasks.trigger('broadcast.decide', {
      broadcastId: value.broadcastId,
      decision: actionId === 'jisr_broadcast_send' ? ('send' as const) : ('cancel' as const),
      slackUserId,
      channelId,
      messageTs,
    });
  }
}

async function handleViewSubmission(payload: SlackInteraction): Promise<void> {
  const callbackId = payload.view?.callback_id ?? '';
  const metadata = ModalValue.safeParse(safeJson(payload.view?.private_metadata));
  if (!metadata.success) return;
  const slackUserId = payload.user?.id ?? '';
  const values = payload.view?.state?.values as Record<string, Record<string, { value?: string }>> | undefined;

  if (callbackId === 'jisr_reply_modal' && metadata.data.caseId) {
    const text = sanitizeText(values?.reply?.text?.value, 600);
    if (!text) return;
    await applyDecision({
      caseId: metadata.data.caseId,
      // A speak-up thread reply is a question for the reporter, not a decision
      // relayed to a named worker; both end up in case.relay either way.
      actionName: 'reply_freeform',
      params: { text },
      slackUserId,
      ...(metadata.data.companyId ? { companyId: metadata.data.companyId } : {}),
    });
    return;
  }

  if (callbackId === 'jisr_edit_hours_modal' && metadata.data.adjustmentId && metadata.data.caseId) {
    const hours = Number(values?.hours?.value?.value ?? '');
    // Server-side validation, always: the modal's own limits are a convenience.
    if (!Number.isFinite(hours) || hours <= 0 || hours > 60) return;
    await tasks.trigger('pay.editHours', {
      adjustmentId: metadata.data.adjustmentId,
      caseId: metadata.data.caseId,
      hoursX100: Math.round(hours * 100),
      slackUserId,
      ...(metadata.data.companyId ? { companyId: metadata.data.companyId } : {}),
    });
    return;
  }

  if (callbackId === 'jisr_reject_pay_modal' && metadata.data.caseId) {
    const reason = sanitizeText(values?.reason?.text?.value, 300);
    if (!reason) return;
    await applyDecision({
      caseId: metadata.data.caseId,
      actionName: 'reject_pay',
      params: { reason },
      slackUserId,
      ...(metadata.data.companyId ? { companyId: metadata.data.companyId } : {}),
    });
  }
}

interface DecisionInput {
  caseId: string;
  actionName: string;
  params: Record<string, unknown>;
  slackUserId: string;
  channelId?: string;
  messageTs?: string;
  /** Supplied by a modal submission, which has no channel to resolve from. */
  companyId?: string;
}

/**
 * The single place a manager decision enters the system, whichever transport
 * delivered it. Authorization happens here, before the waitpoint is completed.
 */
export async function applyDecision(input: DecisionInput): Promise<void> {
  const resolved = await resolveActor(input);
  if (!resolved) return;

  // Re-validate against the allowlisted catalog. A crafted payload dies here.
  const parsed = CaseAction.safeParse({ action: input.actionName, params: input.params });
  if (!parsed.success) {
    await audit({
      event: 'invalid_action_payload',
      severity: 'warn',
      companyId: resolved.companyId,
      actor: resolved.staffId,
      subject: resolved.casePublicId,
      details: { action: input.actionName, issues: parsed.error.issues.map((i) => i.message) },
    });
    return;
  }

  // A speak-up case has no site, so can_act (which resolves through the site)
  // would deny HR. It is gated by can_view_speakup instead - the same relation
  // that let them see the report in the first place.
  const relation = resolved.isSpeakup ? ('can_view_speakup' as const) : ('can_act' as const);
  const allowed = await fga.check({
    user: fga.userRef(resolved.staffId),
    relation,
    object: fga.caseRef(input.caseId),
  });
  if (!allowed) {
    await audit({
      event: 'fga_denied',
      severity: 'warn',
      companyId: resolved.companyId,
      actor: resolved.staffId,
      subject: resolved.casePublicId,
      details: { relation, action: input.actionName },
    });
    return;
  }

  if (!resolved.decisionTokenId) {
    log.warn('decision_without_token', { caseId: input.caseId, action: input.actionName });
    return;
  }

  await wait.completeToken(resolved.decisionTokenId, {
    actorStaffId: resolved.staffId,
    action: parsed.data,
  });

  log.info('decision_applied', {
    casePublicId: resolved.casePublicId,
    action: parsed.data.action,
    actor: resolved.staffId,
  });
}

interface ResolvedActor {
  staffId: string;
  companyId: string;
  casePublicId: string;
  decisionTokenId: string | null;
  isSpeakup: boolean;
}

/**
 * Resolves the clicking Slack user to a staff row, and cross-checks that the card
 * they clicked really belongs to the case named in the button payload.
 */
async function resolveActor(input: {
  caseId: string;
  slackUserId: string;
  channelId?: string;
  messageTs?: string;
  companyId?: string;
}): Promise<ResolvedActor | null> {
  if (!input.slackUserId) return null;

  // The card the click came from is the authoritative source of the case, when
  // we have it: a button value can be replayed, a signed container cannot.
  const byCard =
    input.channelId && input.messageTs
      ? await findCaseBySlackMessage(input.channelId, input.messageTs)
      : null;

  if (byCard && byCard.id !== input.caseId) {
    await audit({
      event: 'slack_action_case_mismatch',
      severity: 'warn',
      companyId: byCard.companyId,
      details: { cardCaseId: byCard.id, payloadCaseId: input.caseId },
    });
    return null;
  }

  // The card is authoritative when we have it; a modal submission falls back to
  // the tenant its private_metadata carried.
  const companyId = byCard?.companyId ?? input.companyId;
  if (!companyId) {
    log.warn('slack_action_unresolvable', { caseId: input.caseId });
    return null;
  }

  return withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const staffRow = await r.staffBySlackUserId(input.slackUserId);
    const caseRow = await r.caseById(input.caseId);
    if (!staffRow || !caseRow) return null;
    return {
      staffId: staffRow.id,
      companyId,
      casePublicId: caseRow.publicId,
      decisionTokenId: caseRow.decisionTokenId,
      isSpeakup: caseRow.isSpeakup,
    };
  });
}

function safeJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
