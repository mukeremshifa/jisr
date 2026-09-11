import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '@jisr/core';

/**
 * Slack request signing, for the Web API fallback path. Interactions that arrive
 * through CopilotKit Intelligence are verified by the Channels runtime instead.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */

const MAX_SKEW_SECONDS = 60 * 5;

export interface SlackVerifyInput {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  now?: Date;
}

export function verifySlackSignature(input: SlackVerifyInput): boolean {
  const secret = config.SLACK_SIGNING_SECRET;
  if (!secret || !input.signature || !input.timestamp) return false;

  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;

  // Replay window. Slack's own guidance: reject anything older than five minutes.
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;

  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const expected = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
