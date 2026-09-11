import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { callLLM, policyAnswerSchema, policySystem, policyUser, POLICY_PROMPT_VERSION } from '@jisr/ai';
import { log, sanitizeText, scrubForModel } from '@jisr/core';
import { repo, withTenant } from '@jisr/db';
import { isExaConfigured, searchOfficialSources } from '@jisr/integrations';
import { chargeTokens } from '../lib/budget';
import { sendToWorker } from '../lib/outbound';
import { trigger, validatedTask } from '../lib/task-kit';

/**
 * C5 — policy questions.
 *
 * Answered from the company handbook plus Exa searches restricted to an
 * allowlist of official UAE domains. Two hard rules, enforced by the prompt and
 * checked again here: no legal advice, and no answer invented when the sources
 * are silent.
 */

let handbookCache: string | null = null;

async function handbook(): Promise<string> {
  if (handbookCache !== null) return handbookCache;
  try {
    // Resolved relative to the repo root in dev and to the bundle in production.
    const url = new URL('../../../../content/handbook.md', import.meta.url);
    handbookCache = await readFile(url, 'utf8');
  } catch (error) {
    log.warn('handbook_unreadable', { error });
    handbookCache = '';
  }
  return handbookCache;
}

/** Keeps the prompt small: only the sections whose words overlap the question. */
function relevantHandbookSections(text: string, question: string): string {
  if (!text) return '(the handbook is not available)';
  const sections = text.split(/\n(?=##\s)/);
  const words = new Set(
    question
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3),
  );
  const scored = sections
    .map((section) => {
      const lower = section.toLowerCase();
      let score = 0;
      for (const word of words) if (lower.includes(word)) score++;
      return { section, score };
    })
    .sort((a, b) => b.score - a.score);

  const picked = scored.filter((s) => s.score > 0).slice(0, 3);
  return (picked.length > 0 ? picked : scored.slice(0, 2)).map((s) => s.section).join('\n\n').slice(0, 4000);
}

export const policyAnswer = validatedTask({
  id: 'policy.answer',
  schema: z.object({
    companyId: z.string().uuid(),
    workerId: z.string().uuid(),
    question: z.string().min(1).max(1000),
    language: z.string().max(8),
  }),
  run: async ({ companyId, workerId, question, language }) => {
    const cleaned = sanitizeText(question, 1000);

    const webResults = isExaConfigured()
      ? await searchOfficialSources(cleaned, 3).catch((error: unknown) => {
          log.warn('exa_search_failed', { error });
          return [];
        })
      : [];

    const text = await handbook();

    const result = await callLLM({
      task: POLICY_PROMPT_VERSION,
      system: policySystem(),
      user: policyUser({
        language,
        question: scrubForModel(cleaned),
        handbookExcerpt: relevantHandbookSections(text, cleaned),
        webResults,
      }),
      schema: policyAnswerSchema,
      schemaName: 'policy_answer',
      maxTokens: 700,
      temperature: 0.1,
    });
    await chargeTokens(companyId, result.tokensUsed);

    await sendToWorker({
      companyId,
      workerId,
      textOriginal: result.data.answerOriginal,
      textEn: result.data.answerEn,
      language,
    });

    // A personal dispute is not a policy question. Offer a case, do not advise.
    if (result.data.shouldOpenCase || result.data.isLegalAdviceRequest) {
      const worker = await withTenant(companyId, ({ tx }) => repo(companyId, tx).workerById(workerId));
      await trigger('case.open', {
        companyId,
        workerId,
        messageId: null,
        transcript: cleaned,
        language,
        category: 'other',
        severity: 'low',
        summaryEn: `Question that needs a human: ${result.data.answerEn}`.slice(0, 400),
        needsReview: true,
        injectionSuspected: false,
        confirmed: false,
        assetId: null,
        missing: [],
        payClaim: null,
      }).catch((error: unknown) => log.warn('policy_case_open_failed', { error }));

      log.info('policy_question_escalated', {
        workerRef: worker?.publicRef ?? null,
        legalAdvice: result.data.isLegalAdviceRequest,
      });
    }

    return { answered: true as const, sources: result.data.sources.length };
  },
});
