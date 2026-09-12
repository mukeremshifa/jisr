import { Hono, type Context } from 'hono';
import { tasks } from '@trigger.dev/sdk';
import {
  RATE_LIMITS,
  RATE_LIMITED_REPLY,
  config,
  decide,
  isPlausibleE164,
  log,
  normalizePhone,
  rateLimitKey,
  sanitizeText,
  unknownSenderReply,
  windowStart,
} from '@jisr/core';
import {
  audit,
  bumpRateLimit,
  findWorkerByPhoneHmac,
  phoneHmac,
  repo,
  withTenant,
} from '@jisr/db';
import {
  parseKapsoWebhook,
  parseMetaWebhook,
  sendWhatsAppMessage,
  validateKapsoSignature,
  validateMetaSignature,
  verifyWebhookChallenge,
} from '@jisr/integrations';

/**
 * The JSON WhatsApp front door, serving both Meta's Cloud API and Kapso — the
 * same job the Twilio route does: validate, deduplicate, rate-limit, persist,
 * enqueue, and answer immediately. It never calls a model.
 *
 * Both carriers get their own path, signature check and parser, and share
 * everything after that. Two differences from the Twilio route, forced by how
 * these APIs work:
 *
 * - The signature covers the raw body, so the body is read as text exactly once
 *   and only parsed after the digest matches.
 * - One POST can carry several messages, so each is handled in turn and a single
 *   bad one never discards the rest of the batch.
 */

export const metaRoutes = new Hono();

const WEBHOOK_PATH = '/webhooks/meta/whatsapp';
const KAPSO_WEBHOOK_PATH = '/webhooks/kapso/whatsapp';

/** Meta's one-time handshake when the webhook URL is saved in the app dashboard. */
metaRoutes.get(WEBHOOK_PATH, (c) => {
  const challenge = verifyWebhookChallenge({
    mode: c.req.query('hub.mode'),
    token: c.req.query('hub.verify_token'),
    challenge: c.req.query('hub.challenge'),
  });
  if (challenge === null) {
    log.warn('meta_webhook_verification_rejected', {});
    return c.text('', 403);
  }
  return c.text(challenge, 200);
});

metaRoutes.post(WEBHOOK_PATH, (c) =>
  handleWebhook(c, {
    path: WEBHOOK_PATH,
    event: 'meta_signature_invalid',
    check: (rawBody) =>
      validateMetaSignature({ signature: c.req.header('x-hub-signature-256'), rawBody }),
    parse: parseMetaWebhook,
  }),
);

/**
 * Kapso posts the same events under its own signature header and envelope. The
 * parser normalises it to the Meta shape, so everything after this line is
 * shared.
 */
metaRoutes.post(KAPSO_WEBHOOK_PATH, (c) =>
  handleWebhook(c, {
    path: KAPSO_WEBHOOK_PATH,
    event: 'kapso_signature_invalid',
    check: (rawBody) =>
      validateKapsoSignature({ signature: c.req.header('x-webhook-signature'), rawBody }),
    parse: parseKapsoWebhook,
  }),
);

interface WebhookHandling {
  path: string;
  event: string;
  check: (rawBody: string) => ReturnType<typeof validateMetaSignature>;
  parse: (body: unknown) => ReturnType<typeof parseMetaWebhook>;
}

async function handleWebhook(c: Context, handling: WebhookHandling): Promise<Response> {
  const rawBody = await c.req.text();
  const check = handling.check(rawBody);
  if (!check.valid) {
    await audit({
      event: handling.event,
      severity: check.reason === 'not_configured' ? 'critical' : 'warn',
      details: { path: handling.path, reason: check.reason },
    });
    // 403 with no body: a probe learns nothing about why it failed.
    return c.text('', 403);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn('whatsapp_webhook_malformed_json', { path: handling.path });
    // 200 anyway: the carrier retries on anything else, and a body we cannot
    // parse will not parse on the retry either.
    return c.body(null, 200);
  }

  const { messages, statuses } = handling.parse(payload);

  for (const status of statuses) {
    await tasks
      .trigger(
        'delivery.status',
        { providerSid: status.providerSid, status: status.status },
        { idempotencyKey: `status:${status.providerSid}:${status.status}` },
      )
      .catch((error: unknown) => log.warn('status_trigger_failed', { error }));
  }

  // Both carriers batch messages; one that fails must not discard the others.
  for (const message of messages) {
    await handleInbound(message).catch((error: unknown) =>
      log.error('whatsapp_inbound_failed', { providerSid: message.providerSid, error }),
    );
  }

  // Always 200: a non-2xx makes the carrier retry the whole batch, including
  // the messages that were handled.
  return c.body(null, 200);
}

async function handleInbound(message: ReturnType<typeof parseMetaWebhook>['messages'][number]): Promise<void> {
  const phone = normalizePhone(message.fromE164);
  if (!message.providerSid || !isPlausibleE164(phone)) {
    log.warn('meta_webhook_malformed', { hasSid: Boolean(message.providerSid) });
    return;
  }

  const hmac = phoneHmac(phone);
  const worker = await findWorkerByPhoneHmac(hmac);

  // ------------------------------------------------------------ unknown sender
  if (!worker || !worker.active) {
    const rule = RATE_LIMITS.unknownSender();
    const count = await bumpRateLimit(rateLimitKey('unknown', hmac), windowStart(rule));
    await audit({
      event: 'unknown_sender',
      severity: 'warn',
      subject: hmac,
      details: { known: Boolean(worker), active: worker?.active ?? false, attempt: count },
    });

    if (decide(rule, count).allowed) {
      await sendWhatsAppMessage({ toE164: phone, body: unknownSenderReply(config.COMPANY_NAME) }).catch(
        (error: unknown) => log.warn('unknown_sender_reply_failed', { error }),
      );
    }
    return;
  }

  // ------------------------------------------------------------- rate limiting
  const rule = RATE_LIMITS.inboundPerWorker(config.CAP_INBOUND_PER_WORKER_PER_HOUR);
  const count = await bumpRateLimit(rateLimitKey('inbound', worker.workerId), windowStart(rule));
  if (!decide(rule, count).allowed) {
    await audit({
      event: 'rate_limited',
      severity: 'warn',
      companyId: worker.companyId,
      actor: `worker:${worker.workerId}`,
      details: { count, max: rule.max },
    });
    if (count === rule.max + 1) {
      await sendWhatsAppMessage({ toE164: phone, body: RATE_LIMITED_REPLY }).catch(() => undefined);
    }
    return;
  }

  // --------------------------------------------- persist (dedupe on message id)
  const stored = await withTenant(worker.companyId, async ({ tx }) => {
    const r = repo(worker.companyId, tx);
    return r.insertMessage({
      workerId: worker.workerId,
      direction: 'inbound',
      channel: 'whatsapp',
      modality: message.modality,
      providerSid: message.providerSid,
      language: worker.language,
      textOriginal: sanitizeText(message.text ?? undefined, 4000) || null,
      lat: message.lat,
      lng: message.lng,
      status: 'received',
    });
  });

  // null means this id is already stored: Meta retried, and everything
  // downstream has already happened.
  if (!stored) {
    log.info('meta_duplicate_ignored', { providerSid: message.providerSid });
    return;
  }

  await tasks.trigger(
    'intake.message',
    {
      companyId: worker.companyId,
      workerId: worker.workerId,
      messageId: stored.id,
      providerSid: message.providerSid,
      // Meta media is addressed by id, and the download URL it resolves to is
      // short-lived, so the id travels with the task rather than being looked
      // up again later.
      mediaRef: message.mediaId ?? undefined,
      mediaContentType: message.mediaContentType ?? undefined,
    },
    {
      concurrencyKey: worker.workerId,
      idempotencyKey: `intake:${message.providerSid}`,
      ttl: '30m',
    },
  );
}
