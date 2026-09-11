import { z } from 'zod';
import { callLLM } from '@jisr/ai';

/**
 * Failure drill 1 — the model key is revoked.
 *
 * Runs the same structured call three ways and prints what a worker would
 * experience each time:
 *   1. normally
 *   2. with the primary forced to fail (FORCE_LLM_FALLBACK)
 *   3. with every provider unreachable
 *
 *   pnpm tsx scripts/drill-model-outage.ts
 */

const Schema = z
  .object({ summaryEn: z.string().max(200), category: z.enum(['maintenance', 'pay', 'safety', 'other']) })
  .strict();

const INPUT = 'The AC in room 214 has been off for two days and it is very hot.';

async function attempt(label: string, mutate: () => void): Promise<void> {
  const saved = { ...process.env };
  mutate();
  const started = Date.now();
  try {
    const result = await callLLM({
      task: 'drill',
      system: 'Summarise this maintenance report. Reply with JSON only.',
      user: INPUT,
      schema: Schema,
      schemaName: 'drill',
      maxTokens: 200,
      temperature: 0,
    });
    process.stdout.write(
      `${label}\n  answered by ${result.provider} (${result.model}) in ${Date.now() - started}ms\n  ${JSON.stringify(result.data)}\n  worker sees: a normal read-back\n\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${label}\n  every provider failed after ${Date.now() - started}ms: ${
        error instanceof Error ? error.message : String(error)
      }\n  worker sees: their report still reaches a human, badged "needs review"\n\n`,
    );
  } finally {
    process.env = saved;
  }
}

async function main(): Promise<void> {
  process.stdout.write('\nDrill: model outage\n\n');
  await attempt('1. Normal', () => {
    process.env.FORCE_LLM_FALLBACK = 'false';
  });
  await attempt('2. Primary revoked (OpenRouter picks it up)', () => {
    process.env.FORCE_LLM_FALLBACK = 'true';
  });
  await attempt('3. Every provider revoked', () => {
    process.env.FORCE_LLM_FALLBACK = 'true';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
}

void main();
