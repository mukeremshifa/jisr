import { createHmac } from 'node:crypto';
import { config } from '@jisr/core';

/**
 * Failure drill 2 — a dropped webhook, and Twilio's retry.
 *
 * Posts the same signed webhook body twice. The first creates a message and
 * enqueues intake; the second is deduplicated on MessageSid and does nothing.
 * Also posts one request with a bad signature, which must be refused.
 *
 *   pnpm tsx scripts/drill-webhook-replay.ts
 */

const PATH = '/webhooks/twilio/whatsapp';

/** Twilio's scheme: sort the POST params, append key+value to the URL, HMAC-SHA1. */
function sign(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

async function post(params: Record<string, string>, signature: string): Promise<number> {
  const response = await fetch(`${config.PUBLIC_GATEWAY_URL}${PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    },
    body: new URLSearchParams(params),
  });
  return response.status;
}

async function main(): Promise<void> {
  if (!config.PUBLIC_GATEWAY_URL || !config.TWILIO_AUTH_TOKEN) {
    throw new Error('PUBLIC_GATEWAY_URL and TWILIO_AUTH_TOKEN are required');
  }

  const from = process.argv[2];
  if (!from) throw new Error('usage: drill-webhook-replay.ts +9715XXXXXXXX (a roster number)');

  const params = {
    MessageSid: `SM${Date.now().toString(16)}${'0'.repeat(10)}`.slice(0, 34),
    From: `whatsapp:${from}`,
    To: config.TWILIO_WHATSAPP_FROM ?? 'whatsapp:+10000000000',
    Body: 'Drill: the AC in room 214 is not working.',
    NumMedia: '0',
  };

  const url = `${config.PUBLIC_GATEWAY_URL.replace(/\/+$/, '')}${PATH}`;
  const signature = sign(url, params, config.TWILIO_AUTH_TOKEN);

  process.stdout.write('\nDrill: dropped webhook and Twilio retry\n\n');
  process.stdout.write(`1. First delivery        -> ${await post(params, signature)} (message stored, intake enqueued)\n`);
  process.stdout.write(`2. Twilio retries it     -> ${await post(params, signature)} (same MessageSid, deduplicated)\n`);
  process.stdout.write(`3. Forged signature      -> ${await post(params, 'bogus')} (expected 403, audited)\n`);
  process.stdout.write('\nCheck the Trigger.dev dashboard: exactly one intake.message run.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
