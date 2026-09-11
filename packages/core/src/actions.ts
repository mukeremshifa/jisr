import { z } from 'zod';

/**
 * The allowlisted manager action catalog. The LLM may only *suggest* names from
 * this list; every parameter is re-validated server-side before the action runs.
 * Nothing outside this catalog can ever reach the case.
 */

export const ScheduleVisitParams = z
  .object({
    // Free text is deliberate ("today 4 PM"), but bounded and sanitized.
    when: z.string().min(1).max(80),
  })
  .strict();

export const AskWorkerParams = z
  .object({
    question: z.string().min(1).max(200),
  })
  .strict();

export const AssignParams = z
  .object({
    /** Omitted means "assign it to whoever clicked", which is the common case. */
    staffId: z.string().uuid().optional(),
  })
  .strict();

export const CloseParams = z
  .object({
    note: z.string().max(300).default(''),
  })
  .strict();

export const ApprovePayStep1Params = z
  .object({
    // Supervisors may correct hours only through the validated modal.
    hoursX100: z.number().int().positive().max(6000).optional(),
  })
  .strict();

export const RejectPayParams = z
  .object({
    reason: z.string().min(1).max(300),
  })
  .strict();

export const AskEvidenceParams = z
  .object({
    what: z.string().max(200).default('a photo of the timesheet'),
  })
  .strict();

export const ReplyFreeformParams = z
  .object({
    text: z.string().min(1).max(600),
  })
  .strict();

export const CaseAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('schedule_visit'), params: ScheduleVisitParams }).strict(),
  z.object({ action: z.literal('ask_worker'), params: AskWorkerParams }).strict(),
  z.object({ action: z.literal('assign'), params: AssignParams }).strict(),
  z.object({ action: z.literal('close'), params: CloseParams }).strict(),
  z.object({ action: z.literal('approve_pay_step1'), params: ApprovePayStep1Params }).strict(),
  z.object({ action: z.literal('reject_pay'), params: RejectPayParams }).strict(),
  z.object({ action: z.literal('ask_evidence'), params: AskEvidenceParams }).strict(),
  z.object({ action: z.literal('reply_freeform'), params: ReplyFreeformParams }).strict(),
]);
export type CaseAction = z.infer<typeof CaseAction>;

export type CaseActionName = CaseAction['action'];

/** Only these may be *suggested* by the model. reply_freeform is always added by us. */
export const SUGGESTABLE_ACTIONS = [
  'schedule_visit',
  'ask_worker',
  'assign',
  'close',
  'approve_pay_step1',
] as const satisfies readonly CaseActionName[];

export const SuggestedActions = z
  .object({
    actions: z
      .array(
        z
          .object({
            action: z.enum(SUGGESTABLE_ACTIONS),
            label: z.string().min(1).max(40),
            params: z.record(z.unknown()).default({}),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
export type SuggestedActions = z.infer<typeof SuggestedActions>;

/** What the waitpoint token resolves to when a manager taps a button. */
export const CaseDecision = z
  .object({
    actorStaffId: z.string().uuid(),
    action: CaseAction,
  })
  .strict();
export type CaseDecision = z.infer<typeof CaseDecision>;

/**
 * Server-side re-validation. The button payload arriving from Slack is untrusted:
 * we parse it into the catalog shape or reject it outright.
 */
export function parseCaseAction(input: unknown): CaseAction {
  return CaseAction.parse(input);
}

export function isPayAction(action: CaseActionName): boolean {
  return action === 'approve_pay_step1' || action === 'reject_pay';
}
