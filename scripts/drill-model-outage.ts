import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { callLLM } from '@jisr/ai';

/**
 * Failure drill 1. The model key is revoked.
 *
 * Runs the same structured call three ways and prints what a worker would
 * experience each time:
 *   1. normally
 *   2. with the primary forced to fail (FORCE_LLM_FALLBACK)
 *   3. with every provider unreachable
 *
 *   pnpm tsx scripts/drill-model-outage.ts
 *
 * Each scenario runs in a child process. `config` is parsed once at module
 * load, so a scenario's env has to be set *before* the LLM layer is imported,
 * mutating `process.env` in-process after the import would change nothing and
 * the drill would silently report a pass for every case.
 */

const Schema = z
  .object({ summaryEn: z.string().max(200), category: z.enum(['maintenance', 'pay', 'safety', 'other']) })
  .strict();

const INPUT = 'The AC in room 214 has been off for two days and it is very hot.';

/** One scenario, in the child: the env is already what the parent set. */
async function runScenario(): Promise<void> {
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
      `  answered by ${result.provider} (${result.model}) in ${Date.now() - started}ms\n  ${JSON.stringify(result.data)}\n  worker sees: a normal read-back\n`,
    );
  } catch (error) {
    process.stdout.write(
      `  every provider failed after ${Date.now() - started}ms: ${
        error instanceof Error ? error.message : String(error)
      }\n  worker sees: their report still reaches a human, badged "needs review"\n`,
    );
  }
}

const execFileAsync = promisify(execFile);

/** Re-executes this file with `JISR_DRILL_SCENARIO` set, so config sees the scenario's env. */
async function attempt(label: string, env: Record<string, string | undefined>): Promise<void> {
  process.stdout.write(`${label}\n`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, JISR_DRILL_SCENARIO: '1' };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url)],
      { env: childEnv, timeout: 120_000 },
    );
    process.stdout.write(stdout);
  } catch (error) {
    process.stdout.write(`  drill could not run: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  if (process.env.JISR_DRILL_SCENARIO) {
    await runScenario();
    return;
  }

  process.stdout.write('\nDrill: model outage\n\n');
  await attempt('1. Normal', { FORCE_LLM_FALLBACK: 'false' });
  await attempt('2. Primary revoked (OpenRouter picks it up)', { FORCE_LLM_FALLBACK: 'true' });
  await attempt('3. Every provider revoked', {
    FORCE_LLM_FALLBACK: 'true',
    OPENROUTER_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  });
}

void main();
