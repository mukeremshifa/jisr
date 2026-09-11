import { describe, expect, it } from 'vitest';
import {
  BINDING_MESSAGE_MAX,
  aedToFils,
  bindingMessage,
  canonicalPayJson,
  computeAmountFils,
  filsToAed,
  hashesMatch,
  hoursToX100,
  payPayloadHash,
  type PayAdjustmentPayload,
} from '@jisr/core';

const basePayload: PayAdjustmentPayload = {
  adjustmentId: '2f9b7e0c-8f4a-4a1e-9d5b-0f2b3c4d5e6f',
  casePublicId: 'JS-9Q2M',
  companyId: '11111111-2222-3333-4444-555555555555',
  workerPublicRef: 'W-0142',
  period: '2026-08',
  kind: 'overtime',
  hoursX100: 1200,
  rateFils: 850,
  multiplierBp: 12500,
  amountFils: 12750,
};

describe('pay amount maths', () => {
  it('computes the worked example from the brief', () => {
    // 12 hours at AED 8.50 with a 1.25 multiplier = AED 127.50
    expect(computeAmountFils({ hoursX100: 1200, rateFils: 850, multiplierBp: 12500 })).toBe(12750);
    expect(filsToAed(12750)).toBe('127.50');
  });

  it('rounds half up, once, at the end', () => {
    // 1.005 hours at 1 fil with a 1x multiplier = 1.005 fils -> 1
    expect(computeAmountFils({ hoursX100: 100, rateFils: 1, multiplierBp: 10_050 })).toBe(1);
    // 0.5 rounds away from zero rather than to even
    expect(computeAmountFils({ hoursX100: 50, rateFils: 1, multiplierBp: 10_000 })).toBe(1);
  });

  it('stays exact at amounts where floats drift', () => {
    // 60h at AED 99.99 with 1.5x: floats give ...9999999 here, integers do not.
    expect(computeAmountFils({ hoursX100: 6000, rateFils: 9999, multiplierBp: 15_000 })).toBe(899_910);
  });

  it('refuses non-integer or non-positive inputs', () => {
    expect(() => computeAmountFils({ hoursX100: 12.5, rateFils: 850, multiplierBp: 12500 })).toThrow();
    expect(() => computeAmountFils({ hoursX100: 0, rateFils: 850, multiplierBp: 12500 })).toThrow();
    expect(() => computeAmountFils({ hoursX100: 1200, rateFils: -1, multiplierBp: 12500 })).toThrow();
  });

  it('round-trips fils and AED', () => {
    expect(aedToFils(127.5)).toBe(12750);
    expect(filsToAed(aedToFils(8.5))).toBe('8.50');
    expect(filsToAed(5)).toBe('0.05');
  });

  it('converts hours to hundredths without float drift', () => {
    expect(hoursToX100(12)).toBe(1200);
    expect(hoursToX100(1.15)).toBe(115);
    expect(hoursToX100(0.07)).toBe(7);
  });
});

describe('hash binding', () => {
  it('is stable regardless of key order in the source object', () => {
    const reordered: PayAdjustmentPayload = {
      amountFils: basePayload.amountFils,
      workerPublicRef: basePayload.workerPublicRef,
      adjustmentId: basePayload.adjustmentId,
      rateFils: basePayload.rateFils,
      period: basePayload.period,
      companyId: basePayload.companyId,
      kind: basePayload.kind,
      multiplierBp: basePayload.multiplierBp,
      hoursX100: basePayload.hoursX100,
      casePublicId: basePayload.casePublicId,
    };
    expect(canonicalPayJson(reordered)).toBe(canonicalPayJson(basePayload));
    expect(payPayloadHash(reordered)).toBe(payPayloadHash(basePayload));
  });

  it('changes when the amount is edited after approval', () => {
    const approved = payPayloadHash(basePayload);
    const tampered = payPayloadHash({ ...basePayload, amountFils: 99_999 });
    expect(hashesMatch(approved, tampered)).toBe(false);
  });

  it('changes when the hours are edited after approval', () => {
    const approved = payPayloadHash(basePayload);
    const tampered = payPayloadHash({ ...basePayload, hoursX100: 6000 });
    expect(hashesMatch(approved, tampered)).toBe(false);
  });

  it('matches itself and rejects malformed comparisons', () => {
    const hash = payPayloadHash(basePayload);
    expect(hashesMatch(hash, hash)).toBe(true);
    expect(hashesMatch(hash, '')).toBe(false);
    expect(hashesMatch(hash, hash.slice(0, -1))).toBe(false);
  });
});

describe('CIBA binding message', () => {
  it('renders the example from the brief and stays short', () => {
    const message = bindingMessage({
      casePublicId: 'JS-9Q2M',
      hoursX100: 1200,
      kindShort: 'OT',
      workerPublicRef: 'W-0142',
      amountFils: 12750,
    });
    expect(message).toBe('JISR 9Q2M 12h OT W-0142 AED127.50');
    expect(message.length).toBeLessThanOrEqual(BINDING_MESSAGE_MAX);
  });

  it('strips characters a lock screen should never have to render', () => {
    const message = bindingMessage({
      casePublicId: 'JS-<b>7F3K',
      hoursX100: 150,
      kindShort: 'NIGHT OT',
      workerPublicRef: 'W-0001',
      amountFils: 100,
    });
    expect(message).not.toMatch(/[<>]/);
    expect(message).toContain('1.50h');
  });
});
