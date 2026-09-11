import twilioSdk from 'twilio';
import { NotConfiguredError, config, log } from '@jisr/core';

/**
 * Twilio WhatsApp: signature validation, sending, and media download.
 *
 * Signature validation is the gateway's front door. It must run against the exact
 * public URL Twilio signed — including scheme, host and query string — which on
 * Cloud Run means the forwarded host, not the internal one.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */

let client: ReturnType<typeof twilioSdk> | undefined;

function getClient() {
  if (client) return client;
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new NotConfiguredError('Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)');
  }
  client = twilioSdk(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  return client;
}

export function isTwilioConfigured(): boolean {
  return Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_WHATSAPP_FROM);
}

export type SignatureFailure = 'not_configured' | 'missing_signature' | 'mismatch' | 'error';

export interface SignatureCheck {
  valid: boolean;
  reason?: SignatureFailure;
}

/**
 * Validates `X-Twilio-Signature`. `url` must be the full public URL of this
 * request; we build it from PUBLIC_GATEWAY_URL rather than trusting Host, so a
 * spoofed Host header cannot change what gets signed.
 *
 * Every failure - including "we have no token to check with" - is a failure, not
 * an exception. A misconfigured deployment must reject webhooks and say why in
 * the audit log, not answer 500 and leak a stack.
 */
export function validateTwilioSignature(input: {
  signature: string | undefined;
  url: string;
  params: Record<string, string>;
}): SignatureCheck {
  if (!config.TWILIO_AUTH_TOKEN) {
    log.error('twilio_auth_token_missing_rejecting_webhook', {});
    return { valid: false, reason: 'not_configured' };
  }
  if (!input.signature) return { valid: false, reason: 'missing_signature' };

  try {
    const ok = twilioSdk.validateRequest(
      config.TWILIO_AUTH_TOKEN,
      input.signature,
      input.url,
      input.params,
    );
    return ok ? { valid: true } : { valid: false, reason: 'mismatch' };
  } catch (error) {
    log.warn('twilio_signature_validation_threw', { error });
    return { valid: false, reason: 'error' };
  }
}

export interface SendWhatsAppInput {
  toE164: string;
  /** Body text. Always sent, even when a voice note goes with it. */
  body: string;
  /** Short-lived signed URL for the voice note. */
  mediaUrl?: string;
  /** Idempotency at our layer: we never send the same logical message twice. */
  statusCallbackUrl?: string;
}

export interface SendResult {
  sid: string;
  status: string;
}

export async function sendWhatsApp(input: SendWhatsAppInput): Promise<SendResult> {
  if (!config.TWILIO_WHATSAPP_FROM) throw new NotConfiguredError('TWILIO_WHATSAPP_FROM');

  const message = await getClient().messages.create({
    from: config.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${input.toE164}`,
    body: input.body,
    ...(input.mediaUrl ? { mediaUrl: [input.mediaUrl] } : {}),
    ...(input.statusCallbackUrl ? { statusCallback: input.statusCallbackUrl } : {}),
  });

  return { sid: message.sid, status: message.status };
}

/**
 * Twilio media URLs need HTTP basic auth with the account credentials. We cap the
 * download so a hostile or broken upstream cannot exhaust memory, and we return
 * the declared content type for the caller to cross-check against magic bytes.
 */
export interface DownloadedMedia {
  bytes: Buffer;
  declaredContentType: string;
}

export async function downloadTwilioMedia(mediaUrl: string, maxBytes: number): Promise<DownloadedMedia> {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new NotConfiguredError('Twilio credentials (media download)');
  }
  const url = new URL(mediaUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.twilio.com')) {
    // Media URLs come from a webhook body: treat them as untrusted input.
    throw new Error(`refusing to download media from ${url.hostname}`);
  }

  const auth = Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(url, {
    headers: { authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`twilio media download failed: ${response.status}`);

  const declaredContentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream';
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > maxBytes) throw new Error(`media too large: ${declaredLength} > ${maxBytes}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error(`media too large: ${buffer.byteLength} > ${maxBytes}`);

  return { bytes: buffer, declaredContentType };
}

/** Empty TwiML: we answer Twilio immediately and do all the work in a task. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Media attached to an inbound message, read back from the Twilio API rather than
 * taken from the webhook body. One fewer piece of externally supplied URL to trust,
 * and the URLs are always current.
 */
export interface TwilioMediaRef {
  sid: string;
  url: string;
  contentType: string;
}

export async function listMessageMedia(messageSid: string): Promise<TwilioMediaRef[]> {
  const items = await getClient().messages(messageSid).media.list({ limit: 5 });
  return items.map((item) => ({
    sid: item.sid,
    // `uri` is the .json resource; the binary lives at the same path without it.
    url: `https://api.twilio.com${item.uri.replace(/\.json$/, '')}`,
    contentType: item.contentType,
  }));
}
