import { z } from 'zod';
import { CaseCategory, CaseSeverity, IntakeUnderstanding } from '@jisr/core';

/**
 * Payload schemas for the tasks that carry a structured understanding around.
 *
 * Internal task payloads use Zod's default strip behaviour rather than
 * `.strict()`: unknown keys are dropped before a handler sees them, which is the
 * protection that matters here. External boundaries - model output, Slack button
 * values, webhook bodies - stay strict.
 */

export const intakeRouteSchema = z.object({
  companyId: z.string().uuid(),
  workerId: z.string().uuid(),
  messageId: z.string().uuid(),
  transcript: z.string().max(4000),
  understanding: IntakeUnderstanding,
  injectionSuspected: z.boolean(),
  pendingAssetId: z.string().uuid().nullable(),
  openCaseId: z.string().uuid().nullable(),
  pendingBroadcastId: z.string().uuid().nullable(),
});

export type IntakeRoutePayload = z.infer<typeof intakeRouteSchema>;

export const caseOpenSchema = z.object({
  companyId: z.string().uuid(),
  workerId: z.string().uuid(),
  /** Null when the case did not start from an inbound message (a policy handoff). */
  messageId: z.string().uuid().nullable(),
  transcript: z.string().max(4000),
  language: z.string().max(8),
  category: CaseCategory,
  severity: CaseSeverity,
  summaryEn: z.string().max(400),
  needsReview: z.boolean(),
  injectionSuspected: z.boolean(),
  confirmed: z.boolean(),
  assetId: z.string().uuid().nullable(),
  missing: z.array(z.string()).default([]),
  payClaim: z
    .object({ period: z.string(), hours: z.number(), kind: z.string() })
    .nullable()
    .default(null),
});

export type CaseOpenPayload = z.infer<typeof caseOpenSchema>;
