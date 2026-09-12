import { createHmac, timingSafeEqual } from 'node:crypto';
import { NotConfiguredError, config, log } from '@jisr/core';
import type { DownloadedMedia, SendResult, SendWhatsAppInput, SignatureCheck } from './twilio';
import type { MetaInboundMessage, MetaStatusUpdate } from './meta';

/**
 * Kapso — a managed WhatsApp carrier sitting in front of Meta.
 *
 * The send API is deliberately Meta-shaped (`messaging_product`, `type`, `text`),
 * so the request bodies here match the Meta adapter's. Three things differ:
 *
 * - Auth is `X-API-Key`, not a bearer token, against Kapso's own base URL.
 * - Webhooks are signed with `X-Webhook-Signature`: hex HMAC-SHA256 over the raw
 *   body, with no `sha256=` prefix.
 * - Inbound media arrives as a ready `media_url` on the payload, so there is no
 *   id-to-URL round trip before downloading.
 *
 * https://docs.kapso.ai/docs/whatsapp/send-messages/text
 * https://docs.kapso.ai/docs/platform/webhooks/overview
 */

export function isKapsoConfigured(): boolean {
  return Boolean(config.KAPSO_API_KEY && config.KAPSO_PHONE_NUMBER_ID);
}

/**
 * Validates `X-Webhook-Signature` against the raw request body.
 *
 * Same fail-closed contract as the other carriers: every failure is a failure,
 * never an exception.
 */
export function validateKapsoSignature(input: {
  signature: string | undefined;
  rawBody: string;
}): SignatureCheck {
  if (!config.KAPSO_WEBHOOK_SECRET) {
    log.error('kapso_webhook_secret_missing_rejecting_webhook', {});
    return { valid: false, reason: 'not_configured' };
  }
  if (!input.signature) return { valid: false, reason: 'missing_signature' };

  try {
    const expected = createHmac('sha256', config.KAPSO_WEBHOOK_SECRET)
      .update(input.rawBody, 'utf8')
      .digest('hex');
    // Kapso sends bare hex; tolerate a `sha256=` prefix so a copied-across
    // secret from another provider's console does not silently fail closed.
    const received = input.signature.replace(/^sha256=/, '');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
    return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'mismatch' };
  } catch (error) {
    log.warn('kapso_signature_validation_threw', { error });
    return { valid: false, reason: 'error' };
  }
}

async function postMessage(body: Record<string, unknown>): Promise<SendResult> {
  if (!config.KAPSO_API_KEY || !config.KAPSO_PHONE_NUMBER_ID) {
    throw new NotConfiguredError('Kapso (KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID)');
  }

  const base = config.KAPSO_API_BASE.replace(/\/+$/, '');
  const response = await fetch(`${base}/${config.KAPSO_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': config.KAPSO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`kapso send failed ${response.status}: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(text) as { messages?: Array<{ id?: string }> };
  const id = parsed.messages?.[0]?.id;
  if (!id) throw new Error('kapso send returned no message id');
  // Delivery is reported later on the webhook; "accepted" is all we know here.
  return { sid: id, status: 'accepted' };
}

/**
 * Sends the text, and the voice note alongside it when there is one.
 *
 * As with Meta, audio and text are two separate messages; the words go first so
 * a worker who cannot play audio still reads them in the right order. WhatsApp
 * renders audio as a voice note only when it is OGG/Opus, which is what the TTS
 * layer already produces.
 */
export async function sendWhatsAppKapso(input: SendWhatsAppInput): Promise<SendResult> {
  const to = input.toE164.replace(/^\+/, '');

  const sent = await postMessage({
    to,
    type: 'text',
    text: { preview_url: false, body: input.body },
  });

  // `voice: true` on an uploaded id is what renders a real voice note; a `link`
  // renders a plain audio file, so the id path is preferred when we have one.
  const audio = input.mediaId ? { id: input.mediaId, voice: true } : input.mediaUrl ? { link: input.mediaUrl } : null;
  if (audio) {
    await postMessage({ to, type: 'audio', audio }).catch((error: unknown) => {
      // The words already went out; a failed voice note must not undo that.
      log.warn('kapso_voice_note_failed', { error });
    });
  }

  return sent;
}

/**
 * Uploads audio bytes to Kapso's media endpoint and returns the media id.
 *
 * Sending a voice note by id rather than by link is what makes WhatsApp render
 * it as a voice note — a mic icon and inline playback — instead of a file with
 * a download arrow. It also means outbound audio needs no public URL, and so no
 * object storage at all.
 *
 * https://docs.kapso.ai/api/meta/whatsapp/media/upload-media
 */
export async function uploadKapsoMedia(input: {
  bytes: Buffer;
  contentType: string;
  filename: string;
}): Promise<string> {
  if (!config.KAPSO_API_KEY || !config.KAPSO_PHONE_NUMBER_ID) {
    throw new NotConfiguredError('Kapso (KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID)');
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.contentType }), input.filename);

  const base = config.KAPSO_API_BASE.replace(/\/+$/, '');
  const response = await fetch(`${base}/${config.KAPSO_PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { 'x-api-key': config.KAPSO_API_KEY },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`kapso media upload failed ${response.status}: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(text) as { id?: string };
  if (!parsed.id) throw new Error('kapso media upload returned no id');
  return parsed.id;
}

/**
 * Downloads one inbound media item from the `media_url` Kapso put on the
 * message. The URL is pre-signed, so it carries no credentials of ours — which
 * is also why it is treated as untrusted and pinned to Kapso's own hosts.
 */
export async function downloadKapsoMedia(mediaUrl: string, maxBytes: number): Promise<DownloadedMedia> {
  const url = new URL(mediaUrl);
  if (url.protocol !== 'https:' || !/(^|\.)kapso\.ai$/.test(url.hostname)) {
    throw new Error(`refusing to download media from ${url.hostname}`);
  }

  const response = await fetch(url, {
    // An API key is harmless on Kapso's own host and required if the URL is not
    // pre-signed.
    headers: config.KAPSO_API_KEY ? { 'x-api-key': config.KAPSO_API_KEY } : {},
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`kapso media download failed: ${response.status}`);

  const declaredContentType =
    response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream';
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > maxBytes) throw new Error(`media too large: ${declaredLength} > ${maxBytes}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`media too large: ${bytes.byteLength} > ${maxBytes}`);

  return { bytes, declaredContentType };
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One `whatsapp.message.received` envelope, or a batch of them. */
function messageEnvelopes(body: unknown): Array<Record<string, any>> {
  const root = body as Record<string, any> | null;
  if (!root || typeof root !== 'object') return [];
  // Buffered delivery wraps several events in `data`; a single event is the
  // envelope itself. `X-Webhook-Batch` says which, but the shape is enough.
  if (root.batch === true && Array.isArray(root.data)) return root.data as Array<Record<string, any>>;
  return [root];
}

/**
 * Flattens Kapso webhook envelopes into the same shape the Meta adapter
 * produces, so the gateway route and everything downstream stay identical.
 *
 * Read defensively throughout: this is remote input, and an envelope we do not
 * recognise is skipped rather than thrown on.
 */
export function parseKapsoWebhook(body: unknown): {
  messages: MetaInboundMessage[];
  statuses: MetaStatusUpdate[];
} {
  const messages: MetaInboundMessage[] = [];
  const statuses: MetaStatusUpdate[] = [];

  for (const envelope of messageEnvelopes(body)) {
    const message = envelope.message as Record<string, any> | undefined;
    if (!message) continue;

    const kapso = (message.kapso ?? {}) as Record<string, any>;
    const id = typeof message.id === 'string' ? message.id : '';

    // Outbound echoes and delivery updates arrive on the same webhook.
    if (kapso.direction && kapso.direction !== 'inbound') {
      if (id && typeof kapso.status === 'string') {
        statuses.push({ providerSid: id, status: kapso.status });
      }
      continue;
    }

    const from =
      typeof message.from === 'string'
        ? message.from
        : typeof envelope.conversation?.phone_number === 'string'
          ? envelope.conversation.phone_number
          : '';
    if (!id || !from) continue;

    const type = typeof message.type === 'string' ? message.type : 'text';
    const mediaData = (kapso.media_data ?? {}) as Record<string, any>;
    const mediaUrl =
      typeof kapso.media_url === 'string'
        ? kapso.media_url
        : typeof mediaData.media_url === 'string'
          ? mediaData.media_url
          : null;

    const text =
      typeof message.text?.body === 'string'
        ? message.text.body
        : typeof kapso.content === 'string'
          ? kapso.content
          : null;

    const location = message.location as Record<string, any> | undefined;

    messages.push({
      providerSid: id,
      fromE164: from.startsWith('+') ? from : `+${from}`,
      text,
      lat: asNumber(location?.latitude),
      lng: asNumber(location?.longitude),
      mediaId: mediaUrl,
      mediaContentType:
        typeof mediaData.content_type === 'string'
          ? mediaData.content_type
          : typeof message[type]?.mime_type === 'string'
            ? message[type].mime_type
            : null,
      modality: location
        ? 'location'
        : type === 'audio' || type === 'voice'
          ? 'audio'
          : type === 'image'
            ? 'image'
            : type === 'sticker'
              ? 'sticker'
              : 'text',
    });
  }

  return { messages, statuses };
}
