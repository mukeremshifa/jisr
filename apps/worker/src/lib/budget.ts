import { RATE_LIMITS, config, log, rateLimitKey, windowStart } from '@jisr/core';
import { audit, bumpRateLimit } from '@jisr/db';

/**
 * The per-company daily token budget, with a circuit breaker.
 *
 * When it trips, Jisr stops calling models for that company, tells the worker
 * "HR will review this", and alerts ops. It does not degrade silently and it does
 * not keep spending.
 */
export async function chargeTokens(companyId: string, tokens: number): Promise<void> {
  const rule = RATE_LIMITS.tokensPerCompany(config.DAILY_TOKEN_BUDGET);
  const used = await bumpRateLimit(rateLimitKey('tokens', companyId), windowStart(rule), Math.max(tokens, 0));
  if (used > rule.max) {
    await audit({
      event: 'token_budget_tripped',
      severity: 'critical',
      companyId,
      details: { used, budget: rule.max },
    });
  }
}

export async function isBudgetTripped(companyId: string): Promise<boolean> {
  const rule = RATE_LIMITS.tokensPerCompany(config.DAILY_TOKEN_BUDGET);
  // Charging zero reads the current window without advancing it.
  const used = await bumpRateLimit(rateLimitKey('tokens', companyId), windowStart(rule), 0);
  const tripped = used > rule.max;
  if (tripped) log.warn('token_budget_blocking', { companyId, used, budget: rule.max });
  return tripped;
}

/**
 * Per-worker audio budget. Audio is the most expensive thing a worker can send,
 * so it is metered separately from message count.
 */
export async function chargeAudioSeconds(workerId: string, seconds: number): Promise<boolean> {
  const rule = RATE_LIMITS.audioSecondsPerWorker(config.CAP_AUDIO_SECONDS_PER_WORKER_PER_DAY);
  const used = await bumpRateLimit(rateLimitKey('audio', workerId), windowStart(rule), Math.max(seconds, 1));
  return used <= rule.max;
}
