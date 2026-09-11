import { describe, expect, it } from 'vitest';
import { CaseAction, SUGGESTABLE_ACTIONS, parseCaseAction } from '@jisr/core';

/**
 * The action catalog is the boundary between "a model suggested something" and
 * "something happened to a case". Everything that crosses it is parsed here.
 */
describe('allowlisted action catalog', () => {
  it('accepts each catalog action with valid parameters', () => {
    expect(parseCaseAction({ action: 'schedule_visit', params: { when: 'today 4 PM' } }).action).toBe(
      'schedule_visit',
    );
    expect(parseCaseAction({ action: 'ask_worker', params: { question: 'Send a photo' } }).action).toBe(
      'ask_worker',
    );
    expect(parseCaseAction({ action: 'close', params: { note: '' } }).action).toBe('close');
    expect(parseCaseAction({ action: 'approve_pay_step1', params: {} }).action).toBe('approve_pay_step1');
  });

  it('rejects an action that is not in the catalog', () => {
    expect(() => parseCaseAction({ action: 'pay_worker', params: { amount: 100000 } })).toThrow();
    expect(() => parseCaseAction({ action: 'reveal_reporter', params: {} })).toThrow();
    expect(() => parseCaseAction({ action: 'delete_case', params: {} })).toThrow();
  });

  it('rejects unknown parameters, so a crafted payload cannot smuggle a field', () => {
    expect(() =>
      parseCaseAction({ action: 'close', params: { note: 'done', amountFils: 999_999 } }),
    ).toThrow();
    expect(() =>
      parseCaseAction({ action: 'approve_pay_step1', params: { skipHrApproval: true } }),
    ).toThrow();
  });

  it('bounds every free-text parameter', () => {
    expect(() => parseCaseAction({ action: 'schedule_visit', params: { when: 'x'.repeat(81) } })).toThrow();
    expect(() => parseCaseAction({ action: 'ask_worker', params: { question: '' } })).toThrow();
    expect(() => parseCaseAction({ action: 'reply_freeform', params: { text: 'y'.repeat(601) } })).toThrow();
  });

  it('caps supervisor hour edits at the same limit as the modal', () => {
    expect(CaseAction.safeParse({ action: 'approve_pay_step1', params: { hoursX100: 6000 } }).success).toBe(
      true,
    );
    expect(CaseAction.safeParse({ action: 'approve_pay_step1', params: { hoursX100: 6001 } }).success).toBe(
      false,
    );
    expect(CaseAction.safeParse({ action: 'approve_pay_step1', params: { hoursX100: 0 } }).success).toBe(
      false,
    );
    expect(CaseAction.safeParse({ action: 'approve_pay_step1', params: { hoursX100: 12.5 } }).success).toBe(
      false,
    );
  });

  it('requires a real staff UUID to assign', () => {
    expect(CaseAction.safeParse({ action: 'assign', params: { staffId: 'me' } }).success).toBe(false);
    expect(
      CaseAction.safeParse({
        action: 'assign',
        params: { staffId: '11111111-2222-3333-4444-555555555555' },
      }).success,
    ).toBe(true);
  });

  it('never lets a model suggest a reply it wrote for a manager', () => {
    // "Reply in my own words" is added by us; a model must not put words in a
    // manager's mouth and label them as the manager's.
    expect(SUGGESTABLE_ACTIONS).not.toContain('reply_freeform');
    expect(SUGGESTABLE_ACTIONS).not.toContain('reject_pay');
  });
});
