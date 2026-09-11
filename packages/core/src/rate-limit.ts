/**
 * Fixed-window rate limiting. The window maths is pure so it can be unit-tested;
 * the counter itself lives in Postgres (`rate_limits`) so every Cloud Run instance
 * shares one view. Fixed windows over sliding ones on purpose: one row, one upsert.
 */

export interface RateLimitRule {
  /** Window length in seconds. */
  windowSeconds: number;
  /** Maximum events allowed per window. */
  max: number;
}

export const RATE_LIMITS = {
  /** Per worker: inbound WhatsApp messages. */
  inboundPerWorker: (max: number): RateLimitRule => ({ windowSeconds: 3600, max }),
  /** Per sender: unknown numbers get one reply per hour, so we cannot be used to spam. */
  unknownSender: (): RateLimitRule => ({ windowSeconds: 3600, max: 1 }),
  /** Per worker: audio seconds per day. `max` is seconds, each call costs N. */
  audioSecondsPerWorker: (max: number): RateLimitRule => ({ windowSeconds: 86_400, max }),
  /** Per company: model tokens per day, the circuit breaker. */
  tokensPerCompany: (max: number): RateLimitRule => ({ windowSeconds: 86_400, max }),
} as const;

/** Start of the fixed window containing `now`, as a Date, so it keys a DB row. */
export function windowStart(rule: RateLimitRule, now: Date = new Date()): Date {
  const ms = rule.windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export function windowEnd(rule: RateLimitRule, now: Date = new Date()): Date {
  return new Date(windowStart(rule, now).getTime() + rule.windowSeconds * 1000);
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Pure decision given the current count. The caller does the atomic increment. */
export function decide(
  rule: RateLimitRule,
  countAfterIncrement: number,
  now: Date = new Date(),
): RateLimitDecision {
  const allowed = countAfterIncrement <= rule.max;
  const remaining = Math.max(0, rule.max - countAfterIncrement);
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(1, Math.ceil((windowEnd(rule, now).getTime() - now.getTime()) / 1000));
  return { allowed, remaining, retryAfterSeconds };
}

/** Namespaced keys keep one worker's audio budget away from their message budget. */
export function rateLimitKey(scope: string, subject: string): string {
  return `${scope}:${subject}`;
}
