import { wait } from '@trigger.dev/sdk';
import { z } from 'zod';
import {
  callLLM,
  relaySystem,
  relayUser,
  readBackSchema,
  readBackSystem,
  readBackUser,
  clarifySchema,
  clarifySystem,
  clarifyUser,
  suggestActionsSystem,
  suggestActionsUser,
  suggestedActionsSchema,
  translationSchema,
  WORKER_MESSAGE_PROMPT_VERSION,
  ACTIONS_PROMPT_VERSION,
} from '@jisr/ai';
import {
  CaseAction,
  CaseCategory,
  CaseDecision,
  CaseSeverity,
  IntakeUnderstanding,
  config,
  features,
  isPendingAssetValid,
  log,
  scrubForModel,
  yesNoPrompt,
  type ActorKind,
} from '@jisr/core';
import { audit, repo, withTenant } from '@jisr/db';
import { fga, notifyManagers, postEscalation, postThreadNote, updateCaseCard } from '@jisr/integrations';
import { chargeTokens } from '../lib/budget';
import { trigger, triggerAndWait, validatedTask } from '../lib/task-kit';
import { caseOpenSchema, intakeRouteSchema } from './payloads';
import { dashboardCaseUrl, loadCaseContext, slaDueAt, slaTimeoutSpec } from '../lib/case-context';
import { sendToWorker } from '../lib/outbound';
import { caseQueue } from '../queues';

/**
 * The case lifecycle: clarify, read back, route, wait for a human, relay the
 * decision back as a voice note.
 *
 * Every human wait is a Trigger.dev waitpoint token with a timeout, so an SLA
 * breach is simply the token timing out. There is no polling anywhere.
 */

const MAX_CLARIFYING_QUESTIONS = 2;
const MAX_CORRECTION_ROUNDS = 1;
/** A bound on how many decisions one case can absorb before we stop waiting. */
const MAX_DECISIONS = 10;

// ---------------------------------------------------------------- intake.route

export const intakeRoute = validatedTask({
  id: 'intake.route',
  schema: intakeRouteSchema,
  queue: caseQueue,
  run: async (payload) => {
    const { companyId, workerId, understanding } = payload;
    const language = understanding.language || 'en';

    // F2 takes precedence over every other branch: a worker who asked to stay
    // anonymous must not have their next message land on a normal case.
    if (features.speakup) {
      const session = await withTenant(companyId, ({ tx }) => repo(companyId, tx).session(workerId));

      if (session?.speakupPending) {
        await trigger('speakup.report', {
          companyId,
          workerId,
          messageId: payload.messageId,
          transcript: payload.transcript,
          language,
          severity: understanding.severity ?? 'high',
          summaryEn: understanding.summaryEn,
        });
        return { routed: 'speakup_report' as const };
      }

      if (session?.speakupCaseId && understanding.intent !== 'policy_question') {
        await trigger('speakup.followUp', {
          companyId,
          caseId: session.speakupCaseId,
          workerId,
          transcript: payload.transcript,
          summaryEn: understanding.summaryEn,
          language,
        });
        return { routed: 'speakup_followup' as const };
      }
    }

    switch (understanding.intent) {
      case 'broadcast_ack': {
        if (payload.pendingBroadcastId) {
          await trigger('broadcast.ack', {
            companyId,
            workerId,
            broadcastId: payload.pendingBroadcastId,
          });
          return { routed: 'broadcast_ack' as const };
        }
        break;
      }

      case 'policy_question': {
        await trigger('policy.answer', {
          companyId,
          workerId,
          question: payload.transcript,
          language,
        });
        return { routed: 'policy_question' as const };
      }

      case 'speakup_request': {
        if (features.speakup) {
          await trigger('speakup.start', { companyId, workerId, entry: 'keyword' as const });
          return { routed: 'speakup_request' as const };
        }
        break;
      }

      case 'confirmation': {
        if (payload.openCaseId) {
          await handleConfirmation({
            companyId,
            workerId,
            caseId: payload.openCaseId,
            confirmation: understanding.confirmation ?? 'unclear',
            language,
          });
          return { routed: 'confirmation' as const };
        }
        break;
      }

      case 'answer_to_question': {
        if (payload.openCaseId) {
          await continueCase({
            companyId,
            workerId,
            caseId: payload.openCaseId,
            understanding,
            transcript: payload.transcript,
            messageId: payload.messageId,
          });
          return { routed: 'answer' as const };
        }
        break;
      }

      default:
        break;
    }

    // Anything that is not a continuation starts a new case.
    await trigger('case.open', {
      companyId,
      workerId,
      messageId: payload.messageId,
      transcript: payload.transcript,
      language,
      category: understanding.category ?? 'other',
      severity: understanding.severity ?? 'medium',
      summaryEn: understanding.summaryEn,
      needsReview: false,
      injectionSuspected: payload.injectionSuspected,
      confirmed: false,
      assetId: payload.pendingAssetId,
      missing: understanding.missing,
      payClaim: understanding.payClaim,
    });

    return { routed: 'report' as const };
  },
});

// ------------------------------------------------------------------ case.open

export const caseOpen = validatedTask({
  id: 'case.open',
  schema: caseOpenSchema,
  queue: caseQueue,
  run: async (payload) => {
    const { companyId, workerId } = payload;

    const created = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const worker = await r.workerById(workerId);
      const session = await r.session(workerId);

      // F1: a sticker scanned in the last 15 minutes supplies the asset and its
      // site, so the worker is never asked where they are.
      const assetId =
        payload.assetId ??
        (session?.pendingAssetId && isPendingAssetValid(session.pendingAssetExpiresAt)
          ? session.pendingAssetId
          : null);
      const asset = assetId ? await r.assetById(assetId) : null;
      const siteId = asset?.siteId ?? worker?.siteId ?? null;

      const row = await r.createCase({
        siteId,
        assetId,
        workerId,
        category: payload.category,
        severity: payload.severity,
        status: 'new',
        language: payload.language,
        summaryEn: payload.summaryEn,
        transcriptOriginal: payload.transcript,
        confirmedByWorker: payload.confirmed,
        injectionSuspected: payload.injectionSuspected,
        needsReview: payload.needsReview,
        slaDueAt: slaDueAt(payload.severity),
      });

      await r.addEvent({
        caseId: row.id,
        type: 'case_opened',
        actorKind: 'worker',
        actorRef: worker?.publicRef ?? null,
        payload: { category: payload.category, severity: payload.severity, missing: payload.missing },
      });

      await r.upsertSession(workerId, {
        lastCaseId: row.id,
        // The sticker context has been consumed.
        pendingAssetId: null,
        pendingAssetExpiresAt: null,
      });

      // Attach the message that started the case, so the card shows its evidence.
      if (payload.messageId) await r.updateMessage(payload.messageId, { caseId: row.id });

      return { row, assetLabel: asset?.label ?? null };
    });

    await fga.writeCaseTuples({
      caseId: created.row.id,
      siteId: created.row.siteId,
      companyId,
    });

    log.info('case_opened', { casePublicId: created.row.publicId, category: payload.category });

    // A pay case needs a period, hours and evidence before it is worth anyone's
    // time, so it clarifies like any other incomplete report.
    const missing = payload.missing.filter((m) => m !== 'when');

    if (missing.length > 0 && !payload.needsReview) {
      await trigger('case.clarify', {
        companyId,
        caseId: created.row.id,
        workerId,
        missing,
      });
      return { caseId: created.row.id, next: 'clarify' as const };
    }

    await trigger('case.readBack', { companyId, caseId: created.row.id, workerId });
    return { caseId: created.row.id, next: 'read_back' as const };
  },
});

// --------------------------------------------------------------- case.clarify

export const caseClarify = validatedTask({
  id: 'case.clarify',
  schema: z
    .object({
      companyId: z.string().uuid(),
      caseId: z.string().uuid(),
      workerId: z.string().uuid(),
      missing: z.array(z.string()).min(1),
    })
    .strict(),
  queue: caseQueue,
  run: async ({ companyId, caseId, workerId, missing }) => {
    const ctx = await loadCaseContext(companyId, caseId);
    if (!ctx) return { asked: false as const };

    // At most two questions in total. After that the case is routed with an
    // "unconfirmed" badge rather than left hanging.
    if (ctx.case.clarifyCount >= MAX_CLARIFYING_QUESTIONS) {
      await trigger('case.route', { companyId, caseId });
      return { asked: false as const, reason: 'limit' };
    }

    const session = await withTenant(companyId, ({ tx }) => repo(companyId, tx).session(workerId));

    const result = await callLLM({
      task: `${WORKER_MESSAGE_PROMPT_VERSION}:clarify`,
      system: clarifySystem(),
      user: clarifyUser({
        language: ctx.case.language,
        summaryEn: scrubForModel(ctx.case.summaryEn ?? ''),
        missing,
        alreadyAsked: session?.pendingQuestion ?? null,
      }),
      schema: clarifySchema,
      schemaName: 'clarifying_question',
      maxTokens: 250,
      temperature: 0.2,
    });
    await chargeTokens(companyId, result.tokensUsed);

    await sendToWorker({
      companyId,
      workerId,
      textOriginal: result.data.questionOriginal,
      textEn: result.data.questionEn,
      language: ctx.case.language,
      caseId,
    });

    await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.transitionCase(caseId, 'clarifying', { clarifyCount: ctx.case.clarifyCount + 1 });
      await r.upsertSession(workerId, {
        pendingQuestion: result.data.questionEn,
        pendingQuestionField: result.data.asksFor,
        lastCaseId: caseId,
      });
      await r.addEvent({
        caseId,
        type: 'clarifying_question_asked',
        actorKind: 'agent',
        payload: { asksFor: result.data.asksFor, questionEn: result.data.questionEn },
      });
    });

    // A worker who never answers must not leave a case invisible. After 30
    // minutes the case is routed anyway, badged unconfirmed.
    await trigger(
      'case.clarifyTimeout',
      { companyId, caseId },
      { delay: '30m', idempotencyKey: `clarify-timeout:${caseId}:${ctx.case.clarifyCount + 1}` },
    );

    return { asked: true as const };
  },
});

export const caseClarifyTimeout = validatedTask({
  id: 'case.clarifyTimeout',
  schema: z.object({ companyId: z.string().uuid(), caseId: z.string().uuid() }).strict(),
  run: async ({ companyId, caseId }) => {
    const ctx = await loadCaseContext(companyId, caseId);
    if (!ctx) return { routed: false as const };
    if (!['clarifying', 'awaiting_confirmation'].includes(ctx.case.status)) {
      return { routed: false as const, reason: 'already moved on' };
    }
    log.info('clarify_timeout_routing_unconfirmed', { casePublicId: ctx.case.publicId });
    await trigger('case.route', { companyId, caseId });
    return { routed: true as const };
  },
});

// -------------------------------------------------------------- case.readBack

export const caseReadBack = validatedTask({
  id: 'case.readBack',
  schema: z
    .object({ companyId: z.string().uuid(), caseId: z.string().uuid(), workerId: z.string().uuid() })
    .strict(),
  queue: caseQueue,
  run: async ({ companyId, caseId, workerId }) => {
    const ctx = await loadCaseContext(companyId, caseId);
    if (!ctx) return { sent: false as const };

    const result = await callLLM({
      task: `${WORKER_MESSAGE_PROMPT_VERSION}:readback`,
      system: readBackSystem(),
      user: readBackUser({
        language: ctx.case.language,
        summaryEn: scrubForModel(ctx.case.summaryEn ?? ''),
        locationLabel: ctx.assetLabel ?? ctx.site?.name ?? null,
      }),
      schema: readBackSchema,
      schemaName: 'read_back',
      maxTokens: 300,
      temperature: 0.2,
    });
    await chargeTokens(companyId, result.tokensUsed);

    // "yes or no" is appended from a fixed table, not generated, so the worker
    // always hears the same two words for the same two answers.
    const question = `${result.data.textOriginal} ${yesNoPrompt(ctx.case.language)}`;

    await sendToWorker({
      companyId,
      workerId,
      textOriginal: question,
      textEn: result.data.textEn,
      language: ctx.case.language,
      caseId,
    });

    await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.transitionCase(caseId, 'awaiting_confirmation');
      await r.upsertSession(workerId, { lastCaseId: caseId, pendingQuestion: null, pendingQuestionField: null });
      await r.addEvent({ caseId, type: 'read_back_sent', actorKind: 'agent', payload: { textEn: result.data.textEn } });
    });

    await trigger(
      'case.clarifyTimeout',
      { companyId, caseId },
      { delay: '30m', idempotencyKey: `readback-timeout:${caseId}` },
    );

    return { sent: true as const };
  },
});

// ----------------------------------------------------------------- case.route

export const caseRoute = validatedTask({
  id: 'case.route',
  schema: z.object({ companyId: z.string().uuid(), caseId: z.string().uuid() }).strict(),
  queue: caseQueue,
  // The case run stays alive across the SLA wait and any follow-up decisions.
  maxDuration: 3600,
  run: async ({ companyId, caseId }) => {
    const ctx = await loadCaseContext(companyId, caseId);
    if (!ctx) return { routed: false as const };
    if (['closed', 'routed', 'escalated', 'in_progress'].includes(ctx.case.status)) {
      return { routed: false as const, reason: 'already routed' };
    }

    const severity = (ctx.case.severity ?? 'medium') as CaseSeverity;

    // Pay cases go down the two-person path instead of the generic one.
    if (ctx.case.category === 'pay' && features.payTwoPerson) {
      await withTenant(companyId, ({ tx }) =>
        repo(companyId, tx).transitionCase(caseId, 'routed', { routedAt: new Date() }),
      );
      await trigger('pay.propose', { companyId, caseId });
      return { routed: true as const, path: 'pay' as const };
    }

    const actions = await suggestActions(companyId, ctx.case.id);

    await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.transitionCase(caseId, 'routed', {
        routedAt: new Date(),
        slaDueAt: slaDueAt(severity),
      });
      await r.addEvent({ caseId, type: 'case_routed', actorKind: 'agent', payload: { actions: actions.length } });
    });

    if (features.ambiguousTasks) {
      await trigger('ambiguous.mirror', { companyId, caseId }).catch((error: unknown) =>
        log.warn('ambiguous_mirror_trigger_failed', { error }),
      );
    }

    // The waitpoint token is the SLA: completing it is a manager decision,
    // letting it expire is an escalation.
    await notifyManagers(companyId, caseId, { actions });

    let escalated = false;
    const outcome = await awaitDecisions({
      companyId,
      caseId,
      firstTimeout: slaTimeoutSpec(severity),
      laterTimeout: `${Math.max(config.DEMO_SLA_MINUTES * 4, 10)}m`,
      onTimeout: async () => {
        if (escalated) return 'stop';
        escalated = true;
        await onSlaBreach(companyId, caseId);
        // One longer window after escalating, then the case waits for a human
        // to pick it up from the dashboard rather than holding a run open.
        return 'continue';
      },
    });

    return { routed: true as const, outcome };
  },
});

// ----------------------------------------------------------- case.createCritical

export const caseCreateCritical = validatedTask({
  id: 'case.createCritical',
  schema: z
    .object({
      companyId: z.string().uuid(),
      workerId: z.string().uuid(),
      messageId: z.string().uuid(),
      transcript: z.string().max(4000),
      language: z.string().max(8),
    })
    .strict(),
  queue: caseQueue,
  run: async (payload) => {
    const { companyId, workerId } = payload;

    const created = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const worker = await r.workerById(workerId);
      const row = await r.createCase({
        siteId: worker?.siteId ?? null,
        workerId,
        category: 'safety',
        severity: 'critical',
        status: 'critical_open',
        language: payload.language,
        summaryEn: `EMERGENCY reported by worker: ${payload.transcript.slice(0, 250)}`,
        transcriptOriginal: payload.transcript,
        confirmedByWorker: false,
        slaDueAt: slaDueAt('critical'),
      });
      await r.updateMessage(payload.messageId, { caseId: row.id });
      await r.upsertSession(workerId, { lastCaseId: row.id });
      await r.addEvent({ caseId: row.id, type: 'emergency_case_opened', actorKind: 'agent', payload: {} });
      return row;
    });

    await fga.writeCaseTuples({ caseId: created.id, siteId: created.siteId, companyId });

    await notifyManagers(companyId, created.id, {
      mentionHere: true,
      statusLine: 'Emergency numbers already sent to the worker. Location requested.',
      actions: [
        { action: 'assign', label: 'I am going now', params: {} },
        { action: 'close', label: 'Resolved', params: { note: '' } },
      ],
    });

    return { caseId: created.id };
  },
});

// ---------------------------------------------------------------- case.relay

export const caseRelay = validatedTask({
  id: 'case.relay',
  schema: z
    .object({
      companyId: z.string().uuid(),
      caseId: z.string().uuid(),
      decisionEn: z.string().max(600),
      /** Terminal relays move the case to decided; questions do not. */
      terminal: z.boolean().default(true),
    })
    .strict(),
  queue: caseQueue,
  run: async ({ companyId, caseId, decisionEn, terminal }) => {
    const ctx = await loadCaseContext(companyId, caseId);
    if (!ctx) return { relayed: false as const };

    const result = await callLLM({
      task: `${WORKER_MESSAGE_PROMPT_VERSION}:relay`,
      system: relaySystem(),
      user: relayUser({ language: ctx.case.language, decisionEn }),
      schema: translationSchema,
      schemaName: 'relay_translation',
      maxTokens: 300,
      temperature: 0.2,
    });
    await chargeTokens(companyId, result.tokensUsed);

    if (ctx.case.isSpeakup) {
      // F2: the reporter is addressed through the sealed identity, never by id.
      const { sendToSealedReporter } = await import('../lib/outbound');
      await sendToSealedReporter({
        companyId,
        caseId,
        textOriginal: result.data.textOriginal,
        language: ctx.case.language,
      });
    } else if (ctx.case.workerId) {
      await sendToWorker({
        companyId,
        workerId: ctx.case.workerId,
        textOriginal: result.data.textOriginal,
        textEn: result.data.textEn,
        language: ctx.case.language,
        caseId,
      });
    }

    await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.addEvent({
        caseId,
        type: 'decision_relayed',
        actorKind: 'agent',
        payload: { decisionEn, terminal },
      });
      if (terminal && !['decided', 'closed'].includes(ctx.case.status)) {
        await r.transitionCase(caseId, 'decided', { firstResponseAt: ctx.case.firstResponseAt ?? new Date() });
      }
    });

    await updateCaseCard(companyId, caseId);
    return { relayed: true as const };
  },
});

// ---------------------------------------------------------------------------

/**
 * Waits for human decisions on a case and applies them, refreshing the waitpoint
 * token after each non-terminal one. Shared by `case.route` and by the speak-up
 * flow, which posts an HR-only card instead of routing to a site channel.
 *
 * Returns when the case is finished with, or when the token times out and
 * `onTimeout` says to stop.
 */
export async function awaitDecisions(input: {
  companyId: string;
  caseId: string;
  firstTimeout: string;
  laterTimeout: string;
  maxRounds?: number;
  onTimeout?: (round: number) => Promise<'continue' | 'stop'>;
}): Promise<'decided' | 'timed_out' | 'exhausted'> {
  const { companyId, caseId } = input;

  let token = await wait.createToken({
    timeout: input.firstTimeout,
    idempotencyKey: `case-decision:${caseId}:1`,
  });
  await withTenant(companyId, ({ tx }) => repo(companyId, tx).updateCase(caseId, { decisionTokenId: token.id }));

  const maxRounds = input.maxRounds ?? MAX_DECISIONS;

  for (let round = 1; round <= maxRounds; round++) {
    const result = await wait.forToken<CaseDecision>(token);

    if (!result.ok) {
      const next = input.onTimeout ? await input.onTimeout(round) : 'stop';
      if (next === 'stop') return 'timed_out';
    } else {
      const parsed = CaseDecision.safeParse(result.output);
      if (!parsed.success) {
        log.warn('decision_payload_invalid', { caseId });
        return 'exhausted';
      }
      if (await applyManagerDecision({ companyId, caseId, decision: parsed.data })) return 'decided';
    }

    token = await wait.createToken({
      timeout: input.laterTimeout,
      idempotencyKey: `case-decision:${caseId}:${round + 1}`,
    });
    await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).updateCase(caseId, { decisionTokenId: token.id }),
    );
  }

  return 'exhausted';
}

/**
 * Applies one manager decision. Returns true when the case is finished with.
 * Every action here came from the allowlisted catalog and passed an FGA check in
 * the gateway before the waitpoint was completed.
 */
export async function applyManagerDecision(input: {
  companyId: string;
  caseId: string;
  decision: CaseDecision;
}): Promise<boolean> {
  const { companyId, caseId } = input;
  const { action, actorStaffId } = input.decision;

  const staffName = await withTenant(companyId, async ({ tx }) => {
    const row = await repo(companyId, tx).staffById(actorStaffId);
    return row?.displayName ?? 'a manager';
  });

  await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    await r.addEvent({
      caseId,
      type: `action:${action.action}`,
      actorKind: 'staff' as ActorKind,
      actorRef: actorStaffId,
      payload: action.params as Record<string, unknown>,
    });
    const current = await r.caseById(caseId);
    if (current && !current.firstResponseAt) {
      await r.updateCase(caseId, { firstResponseAt: new Date() });
    }
  });

  switch (action.action) {
    case 'schedule_visit': {
      await triggerAndWait('case.relay', {
        companyId,
        caseId,
        decisionEn: `A technician will come: ${action.params.when}.`,
        terminal: true,
      });
      return true;
    }

    case 'ask_worker': {
      await triggerAndWait('case.relay', {
        companyId,
        caseId,
        decisionEn: action.params.question,
        terminal: false,
      });
      await withTenant(companyId, async ({ tx }) => {
        const r = repo(companyId, tx);
        const row = await r.caseById(caseId);
        if (row && row.status !== 'in_progress') await r.transitionCase(caseId, 'in_progress');
        if (row?.workerId) await r.upsertSession(row.workerId, { pendingQuestion: action.params.question });
      });
      return false;
    }

    case 'assign': {
      const assigneeId = action.params.staffId ?? actorStaffId;
      const assigneeName =
        assigneeId === actorStaffId
          ? staffName
          : ((await withTenant(companyId, ({ tx }) => repo(companyId, tx).staffById(assigneeId)))
              ?.displayName ?? 'a colleague');

      await withTenant(companyId, async ({ tx }) => {
        const r = repo(companyId, tx);
        const row = await r.caseById(caseId);
        if (row && row.status !== 'in_progress') await r.transitionCase(caseId, 'in_progress');
      });
      await postThreadNote(companyId, caseId, `${assigneeName} is handling this.`);
      await updateCaseCard(companyId, caseId, { statusLine: `In progress with ${assigneeName}` });
      return false;
    }

    case 'close': {
      const note = action.params.note?.trim();
      await triggerAndWait('case.relay', {
        companyId,
        caseId,
        decisionEn: note || 'Your report has been handled and closed.',
        terminal: true,
      });
      await withTenant(companyId, async ({ tx }) => {
        const r = repo(companyId, tx);
        const row = await r.caseById(caseId);
        if (row && row.status !== 'closed') await r.transitionCase(caseId, 'closed');
      });
      await updateCaseCard(companyId, caseId, { statusLine: 'Closed' });
      return true;
    }

    case 'reply_freeform': {
      await triggerAndWait('case.relay', {
        companyId,
        caseId,
        decisionEn: action.params.text,
        terminal: true,
      });
      return true;
    }

    case 'ask_evidence': {
      await triggerAndWait('case.relay', {
        companyId,
        caseId,
        decisionEn: `Please send ${action.params.what}.`,
        terminal: false,
      });
      return false;
    }

    case 'approve_pay_step1': {
      await trigger('pay.supervisorApproved', {
        companyId,
        caseId,
        supervisorStaffId: actorStaffId,
        ...(action.params.hoursX100 === undefined ? {} : { hoursX100: action.params.hoursX100 }),
      });
      return true;
    }

    case 'reject_pay': {
      await trigger('pay.rejected', {
        companyId,
        caseId,
        staffId: actorStaffId,
        reason: action.params.reason,
      });
      return true;
    }

    default: {
      const exhaustive: never = action;
      log.warn('unhandled_action', { action: exhaustive });
      return true;
    }
  }
}

/** C2 SLA: escalate, and tell the worker their case moved up. */
async function onSlaBreach(companyId: string, caseId: string): Promise<void> {
  const ctx = await loadCaseContext(companyId, caseId);
  if (!ctx || ctx.case.firstResponseAt) return;

  await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const row = await r.caseById(caseId);
    if (row && ['routed', 'in_progress', 'critical_open'].includes(row.status)) {
      await r.transitionCase(caseId, 'escalated');
    }
    await r.addEvent({ caseId, type: 'sla_breached', actorKind: 'system', payload: {} });
  });

  await postEscalation(companyId, caseId);

  if (ctx.case.workerId) {
    await trigger('case.relay', {
      companyId,
      caseId,
      decisionEn: 'Your report is now with a senior manager. I will tell you as soon as they decide.',
      terminal: false,
    });
  }
}

/** C1 step 10. A "no" gets exactly one correction round. */
async function handleConfirmation(input: {
  companyId: string;
  workerId: string;
  caseId: string;
  confirmation: 'yes' | 'no' | 'unclear';
  language: string;
}): Promise<void> {
  const { companyId, caseId, workerId } = input;
  const ctx = await loadCaseContext(companyId, caseId);
  if (!ctx) return;

  if (input.confirmation === 'yes') {
    await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.transitionCase(caseId, 'confirmed', { confirmedByWorker: true });
      await r.addEvent({ caseId, type: 'confirmed_by_worker', actorKind: 'worker', payload: {} });
    });
    await trigger('case.route', { companyId, caseId });
    return;
  }

  if (input.confirmation === 'no' && ctx.case.correctionCount < MAX_CORRECTION_ROUNDS) {
    await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).updateCase(caseId, { correctionCount: ctx.case.correctionCount + 1 }),
    );
    await sendToWorker({
      companyId,
      workerId,
      textOriginal: 'Sorry. Tell me again what the problem is.',
      textEn: 'Sorry. Tell me again what the problem is.',
      language: ctx.case.language,
      caseId,
    });
    return;
  }

  // Unclear, or a second "no": route it with the unconfirmed badge rather than
  // keep a worker in a loop.
  await trigger('case.route', { companyId, caseId });
}

/** An answer to a clarifying question: fold it in, then ask again or read back. */
async function continueCase(input: {
  companyId: string;
  workerId: string;
  caseId: string;
  understanding: IntakeUnderstanding;
  transcript: string;
  messageId: string;
}): Promise<void> {
  const { companyId, caseId, workerId } = input;

  await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const row = await r.caseById(caseId);
    if (!row) return;
    await r.updateCase(caseId, {
      summaryEn: `${row.summaryEn ?? ''} ${input.understanding.summaryEn}`.trim().slice(0, 400),
      transcriptOriginal: `${row.transcriptOriginal ?? ''}\n${input.transcript}`.trim().slice(0, 4000),
      ...(input.understanding.category ? { category: input.understanding.category } : {}),
    });
    await r.updateMessage(input.messageId, { caseId });
    await r.upsertSession(workerId, { pendingQuestion: null, pendingQuestionField: null });
    await r.addEvent({
      caseId,
      type: 'answer_received',
      actorKind: 'worker',
      payload: { summaryEn: input.understanding.summaryEn },
    });
  });

  const stillMissing = input.understanding.missing.filter((m) => m !== 'when');
  if (stillMissing.length > 0) {
    await trigger('case.clarify', { companyId, caseId, workerId, missing: stillMissing });
    return;
  }
  await trigger('case.readBack', { companyId, caseId, workerId });
}

/**
 * C2. The model suggests two or three actions from the catalog. Every suggestion
 * is parsed against the catalog schema here; anything that fails is dropped, not
 * repaired. "Reply in my own words" is always added by us.
 */
interface SuggestedButton {
  action: string;
  label: string;
  params: Record<string, unknown>;
}

async function suggestActions(companyId: string, caseId: string): Promise<SuggestedButton[]> {
  const ctx = await loadCaseContext(companyId, caseId);
  if (!ctx) return [];

  const fallback: SuggestedButton[] = [
    { action: 'ask_worker', label: 'Ask for a photo', params: { question: 'Please send a photo.' } },
    { action: 'reply_freeform', label: 'Reply in my own words', params: { text: '' } },
  ];

  try {
    const staffOptions = await withTenant(companyId, async ({ tx }) => {
      const rows = await repo(companyId, tx).allStaff();
      return rows.slice(0, 6).map((s) => ({ id: s.id, name: s.displayName }));
    });

    const result = await callLLM({
      task: ACTIONS_PROMPT_VERSION,
      system: suggestActionsSystem(),
      user: suggestActionsUser({
        category: ctx.case.category ?? 'other',
        severity: ctx.case.severity ?? 'medium',
        summaryEn: scrubForModel(ctx.case.summaryEn ?? ''),
        isPay: ctx.case.category === 'pay',
        staffOptions,
      }),
      schema: suggestedActionsSchema,
      schemaName: 'suggested_actions',
      maxTokens: 400,
      temperature: 0.2,
    });
    await chargeTokens(companyId, result.tokensUsed);

    const validated: SuggestedButton[] = [];
    for (const suggestion of result.data.actions) {
      // The suggestion schema carries every param field as optional, so drop the
      // ones this action did not set before the catalog validates it strictly.
      const params = Object.fromEntries(
        Object.entries(suggestion.params ?? {}).filter(([, v]) => v !== undefined && v !== null),
      );
      const parsed = CaseAction.safeParse({ action: suggestion.action, params });
      if (!parsed.success) {
        log.info('suggested_action_rejected', { action: suggestion.action });
        continue;
      }
      validated.push({
        action: parsed.data.action,
        label: suggestion.label,
        params: parsed.data.params as Record<string, unknown>,
      });
    }

    // "Reply in my own words" is never suggested by a model; it is always there.
    return [...validated.slice(0, 3), { action: 'reply_freeform', label: 'Reply in my own words', params: { text: '' } }];
  } catch (error) {
    log.warn('suggest_actions_failed_using_fallback', { caseId, error });
    return fallback;
  }
}

export { dashboardCaseUrl };
