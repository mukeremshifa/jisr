import { PayEvidence, wrapUntrusted } from '@jisr/core';
import { systemPrompt } from './shared';

/**
 * F3 step 1. Reading a timesheet or payslip photo.
 *
 * The model reads *hours*, never money. Every amount in Jisr is computed on the
 * server from the roster rate and a configured multiplier, so a misread number
 * on a photo cannot become a payment.
 */
export const PAY_EVIDENCE_PROMPT_VERSION = 'pay-evidence@2';

export const payEvidenceSchema = PayEvidence;

export function payEvidenceSystem(): string {
  return systemPrompt([
    'Read a photo of a timesheet or payslip and extract only the period, the hours and the kind of hours.',
    [
      '- period is YYYY-MM. If the photo shows only a month name, use the year the worker mentioned, else null.',
      '- hours is the total number of hours in dispute, at most 60. If you cannot read it clearly, use null.',
      '- kind is overtime, night_overtime, unpaid_days or other.',
      '- readable is false when the photo is too blurry, cropped or dark to read.',
      '- Never return a monetary amount. Never guess a number that is not legible.',
      '- notes: one short sentence on what you could and could not read.',
    ].join('\n'),
  ]);
}

export function payEvidenceUser(input: { claimText: string }): string {
  return `What the worker said:\n${wrapUntrusted(input.claimText)}\n\nRead the attached photo.`;
}
