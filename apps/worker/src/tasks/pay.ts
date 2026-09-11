import { z } from 'zod';
import { callLLM, payEvidenceSchema, payEvidenceSystem, payEvidenceUser, PAY_EVIDENCE_PROMPT_VERSION } from '@jisr/ai';
import {
  PAY_KIND_SHORT,
  bindingMessage,
  computeAmountFils,
  config,
  features,
  filsToAed,
  hashesMatch,
  hoursToX100,
  log,
  payPayloadHash,
  type PayAdjustmentPayload,
} from '@jisr/core';
import { audit, repo, withTenant } from '@jisr/db';
import {
  appendPayrollRow,
  buildPayHrCard,
  buildPaySupervisorCard,
  ciba,
  fga,
  signedUrl,
  slackTransport,
} from '@jisr/integrations';
import { chargeTokens } from '../lib/budget';
import { trigger, validatedTask } from '../lib/task-kit';
import { loadCaseContext } from '../lib/case-context';

/**
 * F3 — the two-person rule for pay corrections.
 *
 * Four properties hold, and each one is enforced in code rather than by process:
 *
 *  1. Two *different* humans approve. The HR approver is chosen by excluding the
 *     supervisor who approved step 1, by staff id and by email. If no distinct
 *     approver exists, the request stays pending and says so.
 *  2. Amounts are computed server-side from the roster rate. The model reads
 *     hours from a photo; it never reads or produces money.
 *  3. Approval is bound to execution by a SHA-256 of the canonical payload. At
 *     execution time we recompute it and abort on any mismatch.
 *  4. Everything is audited.
 */

const MULTIPLIER_BP: Record<string, number> = {
  overtime: config.PAY_OT_MULTIPLIER_BP,
  night_overtime: config.PAY_NIGHT_OT_MULTIPLIER_BP,
  unpaid_days: 10_000,
  other: 10_000,
};

function payloadFor(input: {
  adjustmentId: string;
  casePublicId: string;
  companyId: string;
  workerPublicRef: string;
  period: string;
  kind: string;
  hoursX100: number;
  rateFils: number;
  multiplierBp: number;
  amountFils: number;
}): PayAdjustmentPayload {
  return input;
}

/** Step 2: the server-side proposal. */
export const payPropose = validatedTask({
  id: 'pay.propose',
  schema: z.object({ companyId: z.string().uuid(), caseId: z.string().uuid() }),
  run: async ({ companyId, caseId }) => {
    if (!features.payTwoPerson) return { proposed: false as const };

    const ctx = await loadCaseContext(companyId, caseId);
    if (!ctx?.case.workerId || !ctx.worker) return { proposed: false as const };

    // The claim is read from the worker's words and, when there is a photo, from
    // the photo. Hours only. Never an amount.
    const evidence = await readEvidence(companyId, caseId, ctx.case.transcriptOriginal ?? '');

    const period = evidence.period ?? defaultPeriod();
    const hours = evidence.hours;
    if (hours === null) {
      // Without hours there is nothing to compute, so we ask rather than guess.
      await trigger('case.relay', {
        companyId,
        caseId,
        decisionEn: 'How many hours are missing, and for which month?',
        terminal: false,
      });
      return { proposed: false as const, reason: 'no hours' };
    }

    const kind = evidence.kind ?? 'overtime';
    const hoursX100 = hoursToX100(hours);
    const rateFils = ctx.worker.hourlyRateFils;
    const multiplierBp = MULTIPLIER_BP[kind] ?? config.PAY_OT_MULTIPLIER_BP;

    if (rateFils <= 0) {
      await trigger('case.relay', {
        companyId,
        caseId,
        decisionEn: 'HR needs to check your hourly rate before I can calculate this.',
        terminal: false,
      });
      return { proposed: false as const, reason: 'no rate on roster' };
    }

    const amountFils = computeAmountFils({ hoursX100, rateFils, multiplierBp });

    const adjustment = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const row = await r.createPayAdjustment({
        caseId,
        workerId: ctx.case.workerId!,
        period,
        kind: kind as 'overtime' | 'night_overtime' | 'unpaid_days' | 'other',
        hoursX100,
        rateFils,
        multiplierBp,
        amountFils,
        // Replaced immediately below, once the row has an id to hash.
        payloadSha256: '',
        status: 'pending_supervisor',
      });

      const hash = payPayloadHash(
        payloadFor({
          adjustmentId: row.id,
          casePublicId: ctx.case.publicId,
          companyId,
          workerPublicRef: ctx.worker!.publicRef,
          period,
          kind,
          hoursX100,
          rateFils,
          multiplierBp,
          amountFils,
        }),
      );
      return r.updatePayAdjustment(row.id, { payloadSha256: hash });
    });

    await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).transitionCase(caseId, 'pending_supervisor'),
    );

    await audit({
      event: 'pay_requested',
      companyId,
      subject: ctx.case.publicId,
      details: { adjustmentId: adjustment.id, amountFils, hoursX100, period, kind },
    });

    await postSupervisorCard(companyId, caseId, adjustment.id);

    return { proposed: true as const, adjustmentId: adjustment.id, amountFils };
  },
});

/** Step 3: a supervisor corrects the hours. Recomputed and re-hashed server-side. */
export const payEditHours = validatedTask({
  id: 'pay.editHours',
  schema: z.object({
    adjustmentId: z.string().uuid(),
    caseId: z.string().uuid(),
    hoursX100: z.number().int().positive().max(6000),
    slackUserId: z.string().max(64),
    companyId: z.string().uuid().optional(),
  }),
  run: async (payload) => {
    const companyId = payload.companyId ?? config.DEFAULT_COMPANY_ID;
    if (!companyId) return { edited: false as const };

    const ctx = await loadCaseContext(companyId, payload.caseId);
    if (!ctx?.worker) return { edited: false as const };

    const staffRow = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).staffBySlackUserId(payload.slackUserId),
    );
    if (!staffRow) return { edited: false as const, reason: 'unknown staff' };

    const allowed = await fga.check({
      user: fga.userRef(staffRow.id),
      relation: 'can_act',
      object: fga.caseRef(payload.caseId),
    });
    if (!allowed) {
      await audit({
        event: 'fga_denied',
        severity: 'warn',
        companyId,
        actor: staffRow.id,
        subject: ctx.case.publicId,
        details: { relation: 'can_act', action: 'pay.editHours' },
      });
      return { edited: false as const, reason: 'forbidden' };
    }

    const updated = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const current = await r.payAdjustmentById(payload.adjustmentId);
      if (!current || current.status !== 'pending_supervisor') return null;

      const amountFils = computeAmountFils({
        hoursX100: payload.hoursX100,
        rateFils: current.rateFils,
        multiplierBp: current.multiplierBp,
      });
      const hash = payPayloadHash(
        payloadFor({
          adjustmentId: current.id,
          casePublicId: ctx.case.publicId,
          companyId,
          workerPublicRef: ctx.worker!.publicRef,
          period: current.period,
          kind: current.kind,
          hoursX100: payload.hoursX100,
          rateFils: current.rateFils,
          multiplierBp: current.multiplierBp,
          amountFils,
        }),
      );
      return r.updatePayAdjustment(current.id, {
        hoursX100: payload.hoursX100,
        amountFils,
        payloadSha256: hash,
      });
    });

    if (!updated) return { edited: false as const, reason: 'not editable' };

    await audit({
      event: 'pay_hours_edited',
      companyId,
      actor: staffRow.id,
      subject: ctx.case.publicId,
      details: { hoursX100: payload.hoursX100, amountFils: updated.amountFils },
    });

    await postSupervisorCard(companyId, payload.caseId, updated.id);
    return { edited: true as const, amountFils: updated.amountFils };
  },
});

/** Step 4: the HR approval, out of band, on a phone. */
export const paySupervisorApproved = validatedTask({
  id: 'pay.supervisorApproved',
  schema: z.object({
    companyId: z.string().uuid(),
    caseId: z.string().uuid(),
    supervisorStaffId: z.string().uuid(),
    hoursX100: z.number().int().positive().max(6000).optional(),
  }),
  // CIBA polling runs for the life of the request.
  maxDuration: 1200,
  run: async (payload) => {
    const { companyId, caseId, supervisorStaffId } = payload;

    const ctx = await loadCaseContext(companyId, caseId);
    if (!ctx?.worker) return { approved: false as const };

    const adjustment = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).payAdjustmentByCase(caseId),
    );
    if (!adjustment || adjustment.status !== 'pending_supervisor') {
      return { approved: false as const, reason: 'not pending' };
    }

    // -------------------------------------------------- choose a second human
    const approver = await chooseHrApprover(companyId, supervisorStaffId);
    if (!approver) {
      await slackThreadNote(
        companyId,
        caseId,
        'No HR approver is available who is different from the supervisor who approved step 1. This correction stays pending — two different people must approve it.',
      );
      await audit({
        event: 'pay_no_distinct_approver',
        severity: 'warn',
        companyId,
        subject: ctx.case.publicId,
      });
      return { approved: false as const, reason: 'no distinct approver' };
    }

    const updated = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.transitionCase(caseId, 'pending_hr');
      return r.updatePayAdjustment(adjustment.id, {
        status: 'pending_hr',
        proposedByStaffId: supervisorStaffId,
      });
    });

    await postHrCard(companyId, caseId, updated.id, `Waiting for ${approver.displayName} to approve on their phone`);

    if (!ciba.isCibaConfigured()) {
      await slackThreadNote(
        companyId,
        caseId,
        'Auth0 CIBA is not configured, so the second approval cannot be requested. Nothing has been paid.',
      );
      return { approved: false as const, reason: 'ciba not configured' };
    }

    // ------------------------------------------------------------ CIBA request
    const message = bindingMessage({
      casePublicId: ctx.case.publicId,
      hoursX100: updated.hoursX100,
      kindShort: PAY_KIND_SHORT[updated.kind] ?? 'ADJ',
      workerPublicRef: ctx.worker.publicRef,
      amountFils: updated.amountFils,
    });

    let request: Awaited<ReturnType<typeof ciba.requestApproval>>;
    try {
      request = await ciba.requestApproval({
        loginHint: approver.email,
        bindingMessage: message,
        authorizationDetails: ciba.payrollAuthorizationDetails({
          casePublicId: ctx.case.publicId,
          workerPublicRef: ctx.worker.publicRef,
          period: updated.period,
          kind: `${updated.kind}_correction`,
          hoursX100: updated.hoursX100,
          amountFils: updated.amountFils,
          payloadSha256: updated.payloadSha256,
        }),
      });
    } catch (error) {
      log.error('ciba_request_failed', { caseId, error });
      await slackThreadNote(companyId, caseId, 'I could not reach the approver. Nothing has been paid.');
      return { approved: false as const, reason: 'ciba request failed' };
    }

    await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).updatePayAdjustment(updated.id, {
        authReqId: request.authReqId,
        approvedByStaffId: approver.id,
      }),
    );

    const outcome = await ciba.pollForApproval(request);

    if (outcome.status === 'approved') {
      await withTenant(companyId, async ({ tx }) => {
        const r = repo(companyId, tx);
        await r.transitionCase(caseId, 'approved');
        await r.updatePayAdjustment(updated.id, { status: 'approved', decidedAt: new Date() });
      });
      await audit({
        event: 'pay_approved',
        companyId,
        actor: approver.id,
        subject: ctx.case.publicId,
        details: { adjustmentId: updated.id, amountFils: updated.amountFils, hash: updated.payloadSha256 },
      });
      await trigger(
        'pay.execute',
        { companyId, caseId, adjustmentId: updated.id },
        { idempotencyKey: `pay-execute:${updated.id}` },
      );
      return { approved: true as const };
    }

    const status = outcome.status === 'denied' ? 'denied' : 'expired';
    await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.transitionCase(caseId, status);
      await r.updatePayAdjustment(updated.id, { status, decidedAt: new Date() });
    });
    await audit({
      event: status === 'denied' ? 'pay_denied' : 'pay_expired',
      severity: 'warn',
      companyId,
      actor: approver.id,
      subject: ctx.case.publicId,
      details: { adjustmentId: updated.id },
    });

    await postHrCard(
      companyId,
      caseId,
      updated.id,
      status === 'denied' ? `${approver.displayName} declined this correction` : 'The approval request expired',
    );

    // The worker hears something gentle and true: HR needs more information.
    await trigger('case.relay', {
      companyId,
      caseId,
      decisionEn: 'HR needs more information before your pay correction can be approved. Your case is still open.',
      terminal: false,
    });

    return { approved: false as const, reason: status };
  },
});

/** Step 5: execute exactly what was approved, or refuse. */
export const payExecute = validatedTask({
  id: 'pay.execute',
  schema: z.object({
    companyId: z.string().uuid(),
    caseId: z.string().uuid(),
    adjustmentId: z.string().uuid(),
  }),
  run: async ({ companyId, caseId, adjustmentId }) => {
    const ctx = await loadCaseContext(companyId, caseId);
    const adjustment = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).payAdjustmentById(adjustmentId),
    );
    if (!ctx?.worker || !adjustment) return { executed: false as const };
    if (adjustment.status === 'executed') return { executed: true as const, reason: 'already executed' };
    if (adjustment.status !== 'approved') return { executed: false as const, reason: 'not approved' };

    // ------------------------------------------------------- the hash binding
    const recomputed = payPayloadHash(
      payloadFor({
        adjustmentId: adjustment.id,
        casePublicId: ctx.case.publicId,
        companyId,
        workerPublicRef: ctx.worker.publicRef,
        period: adjustment.period,
        kind: adjustment.kind,
        hoursX100: adjustment.hoursX100,
        rateFils: adjustment.rateFils,
        multiplierBp: adjustment.multiplierBp,
        amountFils: adjustment.amountFils,
      }),
    );

    if (!hashesMatch(recomputed, adjustment.payloadSha256)) {
      // The numbers moved between approval and execution. Nothing is paid.
      await audit({
        event: 'pay_hash_mismatch',
        severity: 'critical',
        companyId,
        subject: ctx.case.publicId,
        details: { adjustmentId, approvedHash: adjustment.payloadSha256, recomputed },
      });
      await slackThreadNote(
        companyId,
        caseId,
        ':rotating_light: This correction changed after it was approved. Payment aborted. A security event has been recorded.',
      );
      return { executed: false as const, reason: 'hash mismatch' };
    }

    const approverName = adjustment.approvedByStaffId
      ? (await withTenant(companyId, ({ tx }) => repo(companyId, tx).staffById(adjustment.approvedByStaffId!)))
          ?.displayName ?? 'HR'
      : 'HR';

    const result = await appendPayrollRow({
      adjustmentId: adjustment.id,
      casePublicId: ctx.case.publicId,
      workerPublicRef: ctx.worker.publicRef,
      period: adjustment.period,
      kind: adjustment.kind,
      hours: (adjustment.hoursX100 / 100).toFixed(2),
      amountAed: filsToAed(adjustment.amountFils),
      approvedBy: approverName,
      payloadSha256: adjustment.payloadSha256,
    });

    if (!result.ok) {
      await slackThreadNote(
        companyId,
        caseId,
        `The approval is recorded but I could not write the payroll row: ${result.detail}. Nothing has been lost — retry from the dashboard.`,
      );
      return { executed: false as const, reason: result.detail };
    }

    await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.updatePayAdjustment(adjustment.id, {
        status: 'executed',
        executedAt: new Date(),
        externalRef: result.externalRef,
      });
      await r.transitionCase(caseId, 'executed');
    });

    await audit({
      event: 'pay_executed',
      companyId,
      subject: ctx.case.publicId,
      details: { adjustmentId, amountFils: adjustment.amountFils, externalRef: result.externalRef },
    });

    await postHrCard(companyId, caseId, adjustment.id, `Executed. Reference ${result.externalRef ?? adjustment.id}`);
    await postSupervisorCard(companyId, caseId, adjustment.id, true);

    const hours = (adjustment.hoursX100 / 100).toFixed(0);
    await trigger('case.relay', {
      companyId,
      caseId,
      decisionEn: `Your ${hours} overtime hours for ${adjustment.period} were approved and will be added to your next salary. Reference ${ctx.case.publicId}.`,
      terminal: true,
    });

    return { executed: true as const, externalRef: result.externalRef };
  },
});

/** The supervisor rejects at step 1. */
export const payRejected = validatedTask({
  id: 'pay.rejected',
  schema: z.object({
    companyId: z.string().uuid(),
    caseId: z.string().uuid(),
    staffId: z.string().uuid(),
    reason: z.string().min(1).max(300),
  }),
  run: async ({ companyId, caseId, staffId, reason }) => {
    const adjustment = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).payAdjustmentByCase(caseId),
    );
    if (!adjustment) return { rejected: false as const };

    await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      await r.updatePayAdjustment(adjustment.id, { status: 'denied', decidedAt: new Date() });
      const row = await r.caseById(caseId);
      if (row && row.status !== 'denied') await r.transitionCase(caseId, 'denied');
    });

    await audit({
      event: 'pay_denied',
      severity: 'warn',
      companyId,
      actor: staffId,
      subject: adjustment.id,
      details: { reason },
    });

    await trigger('case.relay', {
      companyId,
      caseId,
      decisionEn: `Your pay correction was not approved. ${reason}`,
      terminal: true,
    });

    return { rejected: true as const };
  },
});

// ---------------------------------------------------------------------------

/** Vision reads hours from a timesheet photo. It never reads money. */
async function readEvidence(
  companyId: string,
  caseId: string,
  claimText: string,
): Promise<{ period: string | null; hours: number | null; kind: string | null }> {
  const imageUrls = await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const messages = await r.messagesForCase(caseId);
    const urls: string[] = [];
    for (const message of messages) {
      if (!message.mediaId) continue;
      const item = await r.mediaById(message.mediaId);
      if (item?.kind !== 'image') continue;
      try {
        urls.push(await signedUrl(item.gcsKey, 'dashboard'));
      } catch {
        // A missing URL just means one less piece of evidence.
      }
    }
    return urls.slice(0, 2);
  });

  if (imageUrls.length === 0) {
    return { period: null, hours: null, kind: null };
  }

  try {
    const result = await callLLM({
      task: PAY_EVIDENCE_PROMPT_VERSION,
      system: payEvidenceSystem(),
      user: payEvidenceUser({ claimText }),
      schema: payEvidenceSchema,
      schemaName: 'pay_evidence',
      maxTokens: 400,
      temperature: 0,
      imageUrls,
    });
    await chargeTokens(companyId, result.tokensUsed);
    if (!result.data.readable) return { period: null, hours: null, kind: null };
    return { period: result.data.period, hours: result.data.hours, kind: result.data.kind };
  } catch (error) {
    log.warn('pay_evidence_read_failed', { caseId, error });
    return { period: null, hours: null, kind: null };
  }
}

/**
 * The second human. Excluded by staff id *and* by email, because the same person
 * can hold two staff rows. If nobody is left, we return null — never a fallback
 * to one person approving twice.
 */
async function chooseHrApprover(
  companyId: string,
  supervisorStaffId: string,
): Promise<{ id: string; email: string; displayName: string } | null> {
  const candidates = await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const supervisor = await r.staffById(supervisorStaffId);
    const all = await r.allStaff();
    return { supervisorEmail: supervisor?.email.toLowerCase() ?? null, all };
  });

  for (const candidate of candidates.all) {
    if (candidate.id === supervisorStaffId) continue;
    if (candidates.supervisorEmail && candidate.email.toLowerCase() === candidates.supervisorEmail) continue;

    const isHr = await fga.check({
      user: fga.userRef(candidate.id),
      relation: 'hr',
      object: fga.companyRef(companyId),
    });
    if (isHr) return { id: candidate.id, email: candidate.email, displayName: candidate.displayName };
  }
  return null;
}

async function postSupervisorCard(
  companyId: string,
  caseId: string,
  adjustmentId: string,
  decided = false,
): Promise<void> {
  const ctx = await loadCaseContext(companyId, caseId);
  const adjustment = await withTenant(companyId, ({ tx }) =>
    repo(companyId, tx).payAdjustmentById(adjustmentId),
  );
  if (!ctx?.worker || !adjustment) return;

  const channelId = ctx.site?.slackChannelId ?? config.SLACK_DEFAULT_CHANNEL_ID;
  if (!channelId) return;

  const card = buildPaySupervisorCard({
    casePublicId: ctx.case.publicId,
    caseId,
    adjustmentId: adjustment.id,
    workerPublicRef: ctx.worker.publicRef,
    period: adjustment.period,
    hoursX100: adjustment.hoursX100,
    rateFils: adjustment.rateFils,
    multiplierBp: adjustment.multiplierBp,
    amountFils: adjustment.amountFils,
    evidence: [],
    decided,
    ...(decided ? { statusLine: 'Approved by two people and executed.' } : {}),
  });

  if (ctx.case.slackChannelId && ctx.case.slackMessageTs) {
    await slackTransport().update(
      { channelId: ctx.case.slackChannelId, messageTs: ctx.case.slackMessageTs },
      card,
    );
    return;
  }

  const ref = await slackTransport().post(channelId, card);
  await withTenant(companyId, ({ tx }) =>
    repo(companyId, tx).updateCase(caseId, { slackChannelId: ref.channelId, slackMessageTs: ref.messageTs }),
  );
}

async function postHrCard(
  companyId: string,
  caseId: string,
  adjustmentId: string,
  statusLine: string,
): Promise<void> {
  const ctx = await loadCaseContext(companyId, caseId);
  const adjustment = await withTenant(companyId, ({ tx }) =>
    repo(companyId, tx).payAdjustmentById(adjustmentId),
  );
  if (!ctx?.worker || !adjustment || !ctx.case.slackChannelId || !ctx.case.slackMessageTs) return;

  const approverName = adjustment.approvedByStaffId
    ? (await withTenant(companyId, ({ tx }) => repo(companyId, tx).staffById(adjustment.approvedByStaffId!)))
        ?.displayName ?? 'HR'
    : 'HR';

  const card = buildPayHrCard({
    casePublicId: ctx.case.publicId,
    approverName,
    amountFils: adjustment.amountFils,
    hoursX100: adjustment.hoursX100,
    workerPublicRef: ctx.worker.publicRef,
    period: adjustment.period,
    payloadSha256: adjustment.payloadSha256,
    statusLine,
  });

  await slackTransport().postThreadReply(
    { channelId: ctx.case.slackChannelId, messageTs: ctx.case.slackMessageTs },
    { blocks: card.blocks, text: card.text },
  );
}

async function slackThreadNote(companyId: string, caseId: string, text: string): Promise<void> {
  const row = await withTenant(companyId, ({ tx }) => repo(companyId, tx).caseById(caseId));
  if (!row?.slackChannelId || !row.slackMessageTs) return;
  await slackTransport().postThreadReply(
    { channelId: row.slackChannelId, messageTs: row.slackMessageTs },
    { text },
  );
}

/** The month before the current one: the period a worker is usually disputing. */
function defaultPeriod(now: Date = new Date()): string {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}
