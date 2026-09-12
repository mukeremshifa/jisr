import { SUGGESTABLE_ACTIONS, SuggestedActions, wrapUntrusted } from '@jisr/core';
import { systemPrompt } from './shared';

/**
 * C2. The two or three one-tap actions on a case card.
 *
 * The model picks *names* from a fixed catalog. It never invents an action, and
 * every parameter it suggests is re-validated against the catalog schema before
 * the button is rendered, and again when the button is clicked.
 */
export const ACTIONS_PROMPT_VERSION = 'actions@2';

export const suggestedActionsSchema = SuggestedActions;

export function suggestActionsSystem(): string {
  return systemPrompt([
    'Suggest the two or three actions a supervisor is most likely to take on this case.',
    [
      `Choose only from: ${SUGGESTABLE_ACTIONS.join(', ')}.`,
      '- schedule_visit needs params { when: string }, a plain time like "today 4 PM".',
      '- ask_worker needs params { question: string }, one short question.',
      '- assign needs params { staffId: string }, only when a staff id is given to you below.',
      '- close needs params { note: string }.',
      '- approve_pay_step1 needs params {} and only applies to a pay case.',
      'label is the button text: at most four words, plain English, no emoji.',
    ].join('\n'),
    'Order them by how likely they are. Do not suggest closing a case that has just arrived.',
  ]);
}

export function suggestActionsUser(input: {
  category: string;
  severity: string;
  summaryEn: string;
  isPay: boolean;
  staffOptions: Array<{ id: string; name: string }>;
}): string {
  return [
    `Category: ${input.category}`,
    `Severity: ${input.severity}`,
    input.isPay ? 'This is a pay case, so approve_pay_step1 is available.' : '',
    input.staffOptions.length
      ? `Staff you may assign to: ${input.staffOptions.map((s) => `${s.name} (${s.id})`).join(', ')}`
      : 'No staff ids are available, so do not suggest assign.',
    `Case summary:\n${wrapUntrusted(input.summaryEn)}`,
  ]
    .filter(Boolean)
    .join('\n');
}
