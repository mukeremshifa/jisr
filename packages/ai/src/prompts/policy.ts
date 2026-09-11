import { PolicyAnswer, wrapUntrusted } from '@jisr/core';
import { NO_PROMISE_RULE, PLAIN_LANGUAGE_RULE, systemPrompt } from './shared';

/**
 * C5 — policy questions, answered only from the company handbook and official
 * UAE government sources. The hard rule is no legal advice: a personal dispute
 * becomes an offer to open a case plus a pointer to MOHRE.
 */
export const POLICY_PROMPT_VERSION = 'policy@2';

export const policyAnswerSchema = PolicyAnswer;

export function policySystem(): string {
  return systemPrompt([
    'Answer a general question about working rules using only the sources given to you.',
    [
      'Hard rules:',
      '- Never give legal advice, and never say what someone is legally entitled to.',
      '- If the question is about their own dispute, their own contract, or what they can claim, set isLegalAdviceRequest and shouldOpenCase to true and answer by offering to open a case and pointing them to MOHRE.',
      '- If the sources do not answer the question, say you do not know and offer to open a case. Do not fill the gap from memory.',
      '- Name the source in the answer ("from the company handbook", or the site the information came from).',
    ].join('\n'),
    'answerOriginal is in the worker\'s language; answerEn is the English version. sources lists the URLs or "handbook".',
    PLAIN_LANGUAGE_RULE,
    NO_PROMISE_RULE,
  ]);
}

export function policyUser(input: {
  language: string;
  question: string;
  handbookExcerpt: string;
  webResults: Array<{ title: string; url: string; text: string }>;
}): string {
  const sources = input.webResults
    .map((r) => `SOURCE ${r.url}\n${wrapUntrusted(r.text)}`)
    .join('\n\n');

  return [
    `Worker's language: ${input.language}`,
    `Question:\n${wrapUntrusted(input.question)}`,
    `COMPANY HANDBOOK:\n${wrapUntrusted(input.handbookExcerpt)}`,
    sources ? `OFFICIAL SOURCES:\n${sources}` : 'No web sources were available.',
  ].join('\n\n');
}
