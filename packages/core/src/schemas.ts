import { z } from 'zod';

/** Shared contracts. Changing anything here is a cross-lane change, so note it in docs/decisions.md. */

export const CaseCategory = z.enum([
  'maintenance',
  'pay',
  'safety',
  'accommodation',
  'leave',
  'transport',
  'other',
]);
export type CaseCategory = z.infer<typeof CaseCategory>;

export const CaseSeverity = z.enum(['low', 'medium', 'high', 'critical']);
export type CaseSeverity = z.infer<typeof CaseSeverity>;

export const CaseStatus = z.enum([
  'new',
  'clarifying',
  'awaiting_confirmation',
  'confirmed',
  'routed',
  'escalated',
  'in_progress',
  'decided',
  'closed',
  'reopened',
  'critical_open',
  // pay-only states
  'pending_supervisor',
  'pending_hr',
  'approved',
  'executed',
  'denied',
  'expired',
]);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const MissingField = z.enum([
  'where',
  'what',
  'when',
  'pay_period',
  'pay_hours',
  'pay_evidence',
]);
export type MissingField = z.infer<typeof MissingField>;

export const IntakeIntent = z.enum([
  'report',
  'answer_to_question',
  'confirmation',
  'broadcast_ack',
  'policy_question',
  'speakup_request',
  'other',
]);
export type IntakeIntent = z.infer<typeof IntakeIntent>;

export const PayClaim = z
  .object({
    period: z.string().regex(/^\d{4}-\d{2}$/),
    hours: z.number().positive().max(60),
    kind: z.enum(['overtime', 'night_overtime', 'unpaid_days', 'other']),
  })
  .strict();
export type PayClaim = z.infer<typeof PayClaim>;

/** Appendix A. The one structured call that turns a transcript into a decision. */
export const IntakeUnderstanding = z
  .object({
    language: z.string().min(2).max(8),
    intent: IntakeIntent,
    category: CaseCategory.nullable(),
    severity: CaseSeverity.nullable(),
    summaryEn: z.string().max(400),
    confirmation: z.enum(['yes', 'no', 'unclear']).nullable(),
    missing: z.array(MissingField),
    payClaim: PayClaim.nullable(),
    isEmergency: z.boolean(),
    injectionSuspected: z.boolean(),
  })
  .strict();
export type IntakeUnderstanding = z.infer<typeof IntakeUnderstanding>;

/** One short question, in the worker's language plus English for the case record. */
export const ClarifyingQuestion = z
  .object({
    questionOriginal: z.string().max(200),
    questionEn: z.string().max(200),
    asksFor: MissingField,
  })
  .strict();
export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestion>;

export const ReadBack = z
  .object({
    textOriginal: z.string().max(400),
    textEn: z.string().max(400),
  })
  .strict();
export type ReadBack = z.infer<typeof ReadBack>;

export const Translation = z
  .object({
    textOriginal: z.string().max(600),
    textEn: z.string().max(600),
  })
  .strict();
export type Translation = z.infer<typeof Translation>;

/** F2. The redaction pass must return both halves or we do not send anything. */
export const Redaction = z
  .object({
    summaryEnRedacted: z.string().max(600),
    transcriptOriginalRedacted: z.string().max(2000),
    removed: z.array(z.enum(['name', 'employee_number', 'phone', 'room', 'other'])),
  })
  .strict();
export type Redaction = z.infer<typeof Redaction>;

/** F3. Vision extraction from a timesheet or payslip photo. Never an amount. */
export const PayEvidence = z
  .object({
    period: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .nullable(),
    hours: z.number().positive().max(60).nullable(),
    kind: z.enum(['overtime', 'night_overtime', 'unpaid_days', 'other']).nullable(),
    readable: z.boolean(),
    notes: z.string().max(300),
  })
  .strict();
export type PayEvidence = z.infer<typeof PayEvidence>;

/** C5. Grounded policy answer. `sources` are URLs from the allowlist, or the handbook. */
export const PolicyAnswer = z
  .object({
    answerEn: z.string().max(600),
    answerOriginal: z.string().max(600),
    sources: z.array(z.string()).max(4),
    isLegalAdviceRequest: z.boolean(),
    shouldOpenCase: z.boolean(),
  })
  .strict();
export type PolicyAnswer = z.infer<typeof PolicyAnswer>;

export const BroadcastTranslation = z
  .object({
    language: z.string().min(2).max(8),
    text: z.string().max(600),
  })
  .strict();
export type BroadcastTranslation = z.infer<typeof BroadcastTranslation>;

export const ActorKind = z.enum(['worker', 'staff', 'agent', 'system']);
export type ActorKind = z.infer<typeof ActorKind>;

export const MessageDirection = z.enum(['inbound', 'outbound']);
export const MessageModality = z.enum(['text', 'audio', 'image', 'location', 'sticker']);
export const MediaKind = z.enum(['image', 'audio_in', 'audio_out']);
export const AssetKind = z.enum(['room', 'bus', 'machine', 'gate', 'speakup']);
export type AssetKind = z.infer<typeof AssetKind>;

/** Payload for the Trigger.dev intake task. Schema tasks validate this on both ends. */
export const IntakeMessagePayload = z
  .object({
    companyId: z.string().uuid(),
    workerId: z.string().uuid(),
    messageId: z.string().uuid(),
    providerSid: z.string().min(1).max(128),
    /**
     * Meta addresses inbound media by id and cannot list it back from the
     * message later, so the reference travels with the task. Absent on Twilio,
     * where the media is looked up from the MessageSid instead.
     */
    mediaRef: z.string().min(1).max(256).optional(),
    mediaContentType: z.string().min(1).max(128).optional(),
  })
  .strict();
export type IntakeMessagePayload = z.infer<typeof IntakeMessagePayload>;
