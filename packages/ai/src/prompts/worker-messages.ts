import { ClarifyingQuestion, ReadBack, Translation, wrapUntrusted } from '@jisr/core';
import { NO_PROMISE_RULE, PLAIN_LANGUAGE_RULE, glossaryRule, systemPrompt } from './shared';

/** C1 steps 9-10 and C3. Everything Jisr says back to a worker. */
export const WORKER_MESSAGE_PROMPT_VERSION = 'worker-messages@2';

export const clarifySchema = ClarifyingQuestion;
export const readBackSchema = ReadBack;
export const translationSchema = Translation;

export function clarifySystem(): string {
  return systemPrompt([
    'Ask the worker exactly one short question to fill in one missing fact.',
    PLAIN_LANGUAGE_RULE,
    'Write the question in the worker\'s language in questionOriginal, and the same question in English in questionEn.',
    'Ask about one thing only. Never ask for a name, a phone number or an Emirates ID.',
    NO_PROMISE_RULE,
    glossaryRule(),
  ]);
}

export function clarifyUser(input: {
  language: string;
  summaryEn: string;
  missing: string[];
  alreadyAsked: string | null;
}): string {
  return [
    `Worker's language: ${input.language}`,
    `What you understood so far: ${input.summaryEn}`,
    `Missing: ${input.missing.join(', ')}`,
    input.alreadyAsked ? `You already asked: "${input.alreadyAsked}". Do not repeat it.` : '',
    'Ask about the first missing item in the list.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function readBackSystem(): string {
  return systemPrompt([
    "Summarise the worker's report back to them so they can confirm it.",
    PLAIN_LANGUAGE_RULE,
    'State what they reported and where. Then ask if it is right.',
    'textOriginal is in the worker\'s language; textEn is the same thing in English.',
    'Do not add anything they did not say. Do not promise anything.',
    glossaryRule(),
  ]);
}

export function readBackUser(input: {
  language: string;
  summaryEn: string;
  locationLabel: string | null;
}): string {
  return [
    `Worker's language: ${input.language}`,
    `Location: ${input.locationLabel ?? 'not known'}`,
    `What you understood:\n${wrapUntrusted(input.summaryEn)}`,
  ].join('\n');
}

export function relaySystem(): string {
  return systemPrompt([
    "Translate a manager's decision into the worker's language so it can be spoken aloud.",
    PLAIN_LANGUAGE_RULE,
    'Say what was decided and, if it is stated, when. Nothing more.',
    'Do not add reassurance, apologies or promises the manager did not make.',
    'textOriginal is the worker\'s language; textEn is the English version that goes in the case record.',
    glossaryRule(),
  ]);
}

export function relayUser(input: { language: string; decisionEn: string }): string {
  return [
    `Worker's language: ${input.language}`,
    `The manager's decision:\n${wrapUntrusted(input.decisionEn)}`,
  ].join('\n');
}

export function broadcastTranslateSystem(): string {
  return systemPrompt([
    'Translate one announcement for workers, to be spoken aloud as a voice note.',
    PLAIN_LANGUAGE_RULE,
    'Keep every fact exactly: times, places, dates and names do not change.',
    'textOriginal is the target language; textEn is the English source, unchanged.',
    glossaryRule(),
  ]);
}

export function broadcastTranslateUser(input: { language: string; textEn: string }): string {
  return [`Target language: ${input.language}`, `Announcement:\n${wrapUntrusted(input.textEn)}`].join('\n');
}
