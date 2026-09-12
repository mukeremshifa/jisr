import { createHash } from 'node:crypto';

/**
 * Pay maths. Integers only: fils for money, hundredths for hours, basis points
 * for multipliers, so no float ever touches an amount a human approves.
 *
 *   amount_fils = round(hours_x100 × rate_fils × multiplier_bp / 1_000_000)
 */

export interface PayComputationInput {
  hoursX100: number;
  rateFils: number;
  multiplierBp: number;
}

export function computeAmountFils({ hoursX100, rateFils, multiplierBp }: PayComputationInput): number {
  if (!Number.isInteger(hoursX100) || hoursX100 <= 0) throw new RangeError('hoursX100 must be a positive integer');
  if (!Number.isInteger(rateFils) || rateFils <= 0) throw new RangeError('rateFils must be a positive integer');
  if (!Number.isInteger(multiplierBp) || multiplierBp <= 0)
    throw new RangeError('multiplierBp must be a positive integer');

  // Multiply first, divide once: the only rounding happens at the end.
  const scaled = BigInt(hoursX100) * BigInt(rateFils) * BigInt(multiplierBp);
  const divisor = 1_000_000n;
  // Round half away from zero; all inputs are positive so half-up is the same thing.
  const rounded = (scaled + divisor / 2n) / divisor;
  return Number(rounded);
}

export function hoursToX100(hours: number): number {
  return Math.round(hours * 100);
}

export function filsToAed(amountFils: number): string {
  const sign = amountFils < 0 ? '-' : '';
  const abs = Math.abs(amountFils);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function aedToFils(aed: number): number {
  return Math.round(aed * 100);
}

/**
 * The canonical payload. Approval is bound to *these exact bytes*: at execution
 * time we recompute the hash and abort on any mismatch.
 *
 * Key order is fixed here on purpose. JSON.stringify of a literal preserves
 * insertion order, and a stable order is what makes the hash reproducible.
 */
export interface PayAdjustmentPayload {
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
}

export function canonicalPayJson(p: PayAdjustmentPayload): string {
  const ordered = {
    adjustmentId: p.adjustmentId,
    amountFils: p.amountFils,
    casePublicId: p.casePublicId,
    companyId: p.companyId,
    hoursX100: p.hoursX100,
    kind: p.kind,
    multiplierBp: p.multiplierBp,
    period: p.period,
    rateFils: p.rateFils,
    workerPublicRef: p.workerPublicRef,
  };
  return JSON.stringify(ordered);
}

export function payPayloadHash(p: PayAdjustmentPayload): string {
  return createHash('sha256').update(canonicalPayJson(p), 'utf8').digest('hex');
}

/** Constant-time-ish equality on hex digests. Both sides are our own hex, so length is fixed. */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Auth0 CIBA binding message. Short, plain, and readable on a lock screen,
 * Auth0 limits this string, so we keep it well under any documented cap and
 * strip anything outside a conservative character set.
 */
export const BINDING_MESSAGE_MAX = 64;

export function bindingMessage(input: {
  casePublicId: string;
  hoursX100: number;
  kindShort: string;
  workerPublicRef: string;
  amountFils: number;
}): string {
  const shortCase = input.casePublicId.replace(/^JS-/, '');
  const hours = (input.hoursX100 / 100).toFixed(input.hoursX100 % 100 === 0 ? 0 : 2);
  const raw = `JISR ${shortCase} ${hours}h ${input.kindShort} ${input.workerPublicRef} AED${filsToAed(
    input.amountFils,
  )}`;
  return raw.replace(/[^A-Za-z0-9 .\-]/g, '').slice(0, BINDING_MESSAGE_MAX);
}

export const PAY_KIND_SHORT: Record<string, string> = {
  overtime: 'OT',
  night_overtime: 'NIGHT OT',
  unpaid_days: 'UNPAID',
  other: 'ADJ',
};
