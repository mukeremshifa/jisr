import { describe, expect, it } from 'vitest';
import { RATE_LIMITS, decide, rateLimitKey, windowEnd, windowStart } from '@jisr/core';

describe('fixed-window rate limiting', () => {
  const rule = RATE_LIMITS.inboundPerWorker(20);

  it('buckets a timestamp into a stable window', () => {
    const a = windowStart(rule, new Date('2026-09-11T10:07:00Z'));
    const b = windowStart(rule, new Date('2026-09-11T10:59:59Z'));
    expect(a.toISOString()).toBe(b.toISOString());
    expect(a.toISOString()).toBe('2026-09-11T10:00:00.000Z');
  });

  it('starts a new window on the hour', () => {
    const a = windowStart(rule, new Date('2026-09-11T10:59:59Z'));
    const b = windowStart(rule, new Date('2026-09-11T11:00:00Z'));
    expect(a.getTime()).not.toBe(b.getTime());
    expect(windowEnd(rule, new Date('2026-09-11T10:00:00Z')).toISOString()).toBe('2026-09-11T11:00:00.000Z');
  });

  it('allows up to the limit and refuses the one after', () => {
    expect(decide(rule, 1).allowed).toBe(true);
    expect(decide(rule, 20).allowed).toBe(true);
    expect(decide(rule, 20).remaining).toBe(0);
    expect(decide(rule, 21).allowed).toBe(false);
  });

  it('tells a refused caller when to come back', () => {
    const now = new Date('2026-09-11T10:30:00Z');
    const decision = decide(rule, 21, now);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(30 * 60);
  });

  it('lets an unknown sender be answered once an hour', () => {
    const unknown = RATE_LIMITS.unknownSender();
    expect(decide(unknown, 1).allowed).toBe(true);
    expect(decide(unknown, 2).allowed).toBe(false);
  });

  it('meters audio by the second over a day', () => {
    const audio = RATE_LIMITS.audioSecondsPerWorker(600);
    expect(audio.windowSeconds).toBe(86_400);
    expect(decide(audio, 600).allowed).toBe(true);
    expect(decide(audio, 601).allowed).toBe(false);
  });

  it('namespaces keys so one budget cannot spend another', () => {
    expect(rateLimitKey('inbound', 'w1')).not.toBe(rateLimitKey('audio', 'w1'));
  });
});
