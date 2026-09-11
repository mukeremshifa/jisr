import { Hono } from 'hono';
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
import { EMPTY_TWIML, sendWhatsApp, validateTwilioSignature } from '@jisr/integrations';
import { publicUrlFor } from '../lib/public-url';

/**
 * C1 step 1-3. The gateway's whole job on an inbound message:
 * validate, deduplicate, rate-limit, persist, enqueue, answer in under a second.
 * It never calls a model and never blocks on anything slow.
 */

export const twilioRoutes = new Hono();

const WHATSAPP_WEBHOOK_PATH = '/webhooks/twilio/whatsapp';
const STATUS_WEBHOOK_PATH = '/webhooks/twilio/status';

/** Twilio posts form-encoded bodies; the signature covers every field. */
async function formParams(request: Request): Promise<Record<string, string>> {
  const text = await request.text();
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) params[key] = value;
  return params;
}

twilioRoutes.post(WHATSAPP_WEBHOOK_PATH, async (c) => {
  const params = await formParams(c.req.raw.clone());
  const signature = c.req.header('x-twilio-signature');
  const url = publicUrlFor(WHATSAPP_WEBHOOK_PATH, new URL(c.req.url).search);

  const check = validateTwilioSignature({ signature, url, params });
  if (!check.valid) {
    await audit({
      event: 'twilio_signature_invalid',
      severity: check.reason === 'not_configured' ? 'critical' : 'warn',
      details: { path: WHATSAPP_WEBHOOK_PATH, reason: check.reason },
    });
    // 403 with no body: a probe learns nothing about why it failed.
    return c.text('', 403);
  }

  const providerSid = params.MessageSid ?? params.SmsMessageSid ?? '';
  const fromRaw = params.From ?? '';
  const phone = normalizePhone(fromRaw);

  if (!providerSid || !isPlausibleE164(phone)) {
    log.warn('twilio_webhook_malformed', { hasSid: Boolean(providerSid) });
    return c.text(EMPTY_TWIML, 200, { 'content-type': 'text/xml' });
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

    // One reply per hour, so Jisr cannot be used to send repeated messages to a
    // number that is not ours.
    if (decide(rule, count).allowed) {
      await sendWhatsApp({ toE164: phone, body: unknownSenderReply(config.COMPANY_NAME) }).catch(
        (error: unknown) => log.warn('unknown_sender_reply_failed', { error }),
      );
    }
    return c.text(EMPTY_TWIML, 200, { 'content-type': 'text/xml' });
  }

  // ------------------------------------------------------------- rate limiting
  const rule = RATE_LIMITS.inboundPerWorker(config.CAP_INBOUND_PER_WORKER_PER_HOUR);
  const count = await bumpRateLimit(rateLimitKey('inbound', worker.workerId), windowStart(rule));
  const decision = decide(rule, count);
  if (!decision.allowed) {
    await audit({
      event: 'rate_limited',
      severity: 'warn',
      companyId: worker.companyId,
      actor: `worker:${worker.workerId}`,
      details: { count, max: rule.max },
    });
    // Exactly one notice, on the message that crosses the line.
    if (count === rule.max + 1) {
      await sendWhatsApp({ toE164: phone, body: RATE_LIMITED_REPLY }).catch(() => undefined);
    }
    return c.text(EMPTY_TWIML, 200, { 'content-type': 'text/xml' });
  }

  // ----------------------------------------------- persist (dedupe on MessageSid)
  const stored = await withTenant(worker.companyId, async ({ tx }) => {
    const r = repo(worker.companyId, tx);
    return r.insertMessage({
      workerId: worker.workerId,
      direction: 'inbound',
      channel: 'whatsapp',
      modality: modalityOf(params),
      providerSid,
      language: worker.language,
      textOriginal: sanitizeText(params.Body, 4000) || null,
      lat: numberOrNull(params.Latitude),
      lng: numberOrNull(params.Longitude),
      status: 'received',
    });
  });

  // insertMessage returns null when the MessageSid already exists: Twilio retried,
  // and every side effect downstream has already happened.
  if (!stored) {
    log.info('twilio_duplicate_ignored', { providerSid });
    return c.text(EMPTY_TWIML, 200, { 'content-type': 'text/xml' });
  }

  // ------------------------------------------------------------------- enqueue
  try {
    await tasks.trigger(
      'intake.message',
      {
        companyId: worker.companyId,
        workerId: worker.workerId,
        messageId: stored.id,
        providerSid,
      },
      {
        // Messages from one worker are processed strictly in order.
        concurrencyKey: worker.workerId,
        // Twilio retries; the task must run at most once per message.
        idempotencyKey: `intake:${providerSid}`,
        // Twilio media URLs stop working after a while; no point retrying for days.
        ttl: '30m',
      },
    );
  } catch (error) {
    log.error('intake_trigger_failed', { providerSid, error });
    // Still 200: Twilio will retry, and the MessageSid dedupe makes that safe.
    return c.text(EMPTY_TWIML, 500, { 'content-type': 'text/xml' });
  }

  return c.text(EMPTY_TWIML, 200, { 'content-type': 'text/xml' });
});

/** Delivery receipts. Same signature rule; used to mark broadcast deliveries. */
twilioRoutes.post(STATUS_WEBHOOK_PATH, async (c) => {
  const params = await formParams(c.req.raw.clone());
  const signature = c.req.header('x-twilio-signature');
  const url = publicUrlFor(STATUS_WEBHOOK_PATH, new URL(c.req.url).search);

  const check = validateTwilioSignature({ signature, url, params });
  if (!check.valid) {
    await audit({
      event: 'twilio_signature_invalid',
      severity: check.reason === 'not_configured' ? 'critical' : 'warn',
      details: { path: STATUS_WEBHOOK_PATH, reason: check.reason },
    });
    return c.text('', 403);
  }

  const sid = params.MessageSid ?? params.SmsSid ?? '';
  const status = params.MessageStatus ?? params.SmsStatus ?? '';
  if (sid && status) {
    await tasks
      .trigger('delivery.status', { providerSid: sid, status }, { idempotencyKey: `status:${sid}:${status}` })
      .catch((error: unknown) => log.warn('status_trigger_failed', { error }));
  }
  return c.body(null, 204);
});

function modalityOf(params: Record<string, string>): 'text' | 'audio' | 'image' | 'location' | 'sticker' {
  if (params.Latitude && params.Longitude) return 'location';
  const mediaType = params.MediaContentType0 ?? '';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('image/')) return 'image';
  return 'text';
}

function numberOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
