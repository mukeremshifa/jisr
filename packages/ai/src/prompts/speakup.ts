import { Redaction, wrapUntrusted } from '@jisr/core';
import { PLAIN_LANGUAGE_RULE, systemPrompt } from './shared';

/**
 * F2 step 3 — redaction.
 *
 * This pass removes what a person could be recognised by. A regex pass runs
 * afterwards for Emirates ID numbers, IBANs and phone numbers; this one handles
 * what a regex cannot see: names, job titles that identify one person, room
 * numbers, and "the only Nepali welder on night shift".
 */
export const SPEAKUP_PROMPT_VERSION = 'speakup@2';

export const redactionSchema = Redaction;

export function redactSystem(): string {
  return systemPrompt([
    'Remove everything that could identify the person who sent this report, then return it.',
    [
      'Remove or generalise:',
      '- names of the reporter and of anyone they mention as a colleague',
      '- employee numbers, badge numbers, phone numbers, Emirates ID numbers',
      '- room numbers, bed numbers, bus numbers and shift times when they point at one person',
      '- any detail that would single out one worker ("the only X on Y shift")',
      'Keep the substance: what happened, roughly where, roughly when, and who it is about when that person is a manager.',
      'Names of managers the report is *about* stay, because HR needs them to act.',
    ].join('\n'),
    'summaryEnRedacted is the English summary. transcriptOriginalRedacted is the original-language text with the same removals.',
    'removed lists the kinds of thing you took out.',
    PLAIN_LANGUAGE_RULE,
  ]);
}

export function redactUser(input: { language: string; summaryEn: string; transcriptOriginal: string }): string {
  return [
    `Original language: ${input.language}`,
    `English summary:\n${wrapUntrusted(input.summaryEn)}`,
    `Original transcript:\n${wrapUntrusted(input.transcriptOriginal)}`,
  ].join('\n');
}
