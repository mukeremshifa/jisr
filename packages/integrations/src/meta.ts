import { createHmac, timingSafeEqual } from 'node:crypto';
import { NotConfiguredError, config, log } from '@jisr/core';
import type { DownloadedMedia, SendResult, SendWhatsAppInput, SignatureCheck } from './twilio';

/**
 * Meta WhatsApp Cloud API. The second WhatsApp carrier, behind the same four
 * functions the Twilio adapter exposes. `WHATSAPP_PROVIDER` picks between them
 * and nothing downstream changes.
 *
 * Two things differ from Twilio and shape this file:
 *
 * - Webhooks are JSON, and the signature is HMAC-SHA256 over the **raw body**
 *   rather than over the URL and sorted fields. The body must be read exactly
 *   once, unparsed, or the digest will not match.
 * - Media arrives as an id, not a URL. Fetching it is two calls: resolve the id
 *   to a short-lived URL, then download that URL with the access token attached.
 *
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */

function graph(path: string): string {
  return `https://graph.facebook.com/${config.META_GRAPH_VERSION}/${path}`;
}

export function isMetaConfigured(): boolean {
  return Boolean(config.META_PHONE_NUMBER_ID && config.META_ACCESS_TOKEN);
}

/**
 * Validates `X-Hub-Signature-256` against the raw request body.
 *
 * Every failure is a failure rather than an exception, mirroring the Twilio
 * adapter: a misconfigured deployment must reject webhooks and say why in the
 * audit log, not answer 500.
 */
export function validateMetaSignature(input: {
  signature: string | undefined;
  rawBody: string;
}): SignatureCheck {
  if (!config.META_APP_SECRET) {
    log.error('meta_app_secret_missing_rejecting_webhook', {});
    return { valid: false, reason: 'not_configured' };
  }
  if (!input.signature) return { valid: false, reason: 'missing_signature' };

  try {
    const expected =
      'sha256=' +
      createHmac('sha256', config.META_APP_SECRET).update(input.rawBody, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(input.signature, 'utf8');
    // Compare in constant time, and only when the lengths already match:
    // timingSafeEqual throws on a length mismatch.
    if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
    return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'mismatch' };
  } catch (error) {
    log.warn('meta_signature_validation_threw', { error });
    return { valid: false, reason: 'error' };
  }
}

/** The GET handshake Meta performs once when a webhook URL is saved. */
export function verifyWebhookChallenge(query: {
  mode: string | undefined;
  token: string | undefined;
  challenge: string | undefined;
}): string | null {
  if (!config.META_VERIFY_TOKEN) return null;
  if (query.mode !== 'subscribe') return null;
  if (query.token !== config.META_VERIFY_TOKEN) return null;
  return query.challenge ?? null;
}

async function postMessage(body: Record<string, unknown>): Promise<SendResult> {
  if (!config.META_PHONE_NUMBER_ID || !config.META_ACCESS_TOKEN) {
    throw new NotConfiguredError('Meta (META_PHONE_NUMBER_ID, META_ACCESS_TOKEN)');
  }

  const response = await fetch(graph(`${config.META_PHONE_NUMBER_ID}/messages`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.META_ACCESS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`meta send failed ${response.status}: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(text) as { messages?: Array<{ id?: string }> };
  const id = parsed.messages?.[0]?.id;
  if (!id) throw new Error('meta send returned no message id');
  // Meta reports delivery asynchronously on the status webhook, so the only
  // status we can honestly claim here is "accepted".
  return { sid: id, status: 'accepted' };
}

/**
 * Sends text, and the voice note alongside it when there is one.
 *
 * Meta has no single-call equivalent of Twilio's body-plus-media message: audio
 * and text are two messages. The text is sent first so a worker who cannot play
 * audio still sees the words in the right order.
 */
export async function sendWhatsAppMeta(input: SendWhatsAppInput): Promise<SendResult> {
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
      log.warn('meta_voice_note_failed', { error });
    });
  }

  return sent;
}

/**
 * Uploads audio bytes to the Cloud API media endpoint and returns the media id.
 *
 * OGG/Opus mono is the only audio WhatsApp accepts as a voice note, which is
 * what the TTS layer already produces.
 *
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 */
export async function uploadMetaMedia(input: {
  bytes: Buffer;
  contentType: string;
  filename: string;
}): Promise<string> {
  if (!config.META_PHONE_NUMBER_ID || !config.META_ACCESS_TOKEN) {
    throw new NotConfiguredError('Meta (META_PHONE_NUMBER_ID, META_ACCESS_TOKEN)');
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', input.contentType);
  form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.contentType }), input.filename);

  const response = await fetch(graph(`${config.META_PHONE_NUMBER_ID}/media`), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.META_ACCESS_TOKEN}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`meta media upload failed ${response.status}: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(text) as { id?: string };
  if (!parsed.id) throw new Error('meta media upload returned no id');
  return parsed.id;
}

export interface MetaMediaRef {
  id: string;
  contentType: string;
}

/**
 * Resolves a media id to its short-lived download URL and fetches it.
 *
 * The URL is on a Meta CDN host and still needs the access token, so the
 * download cannot be delegated to anything that does not hold our credentials.
 */
export async function downloadMetaMedia(mediaId: string, maxBytes: number): Promise<DownloadedMedia> {
  if (!config.META_ACCESS_TOKEN) throw new NotConfiguredError('META_ACCESS_TOKEN');
  const auth = { authorization: `Bearer ${config.META_ACCESS_TOKEN}` };

  const lookup = await fetch(graph(mediaId), { headers: auth, signal: AbortSignal.timeout(20_000) });
  if (!lookup.ok) throw new Error(`meta media lookup failed: ${lookup.status}`);
  const meta = (await lookup.json()) as { url?: string; mime_type?: string; file_size?: number };
  if (!meta.url) throw new Error('meta media lookup returned no url');
  if (typeof meta.file_size === 'number' && meta.file_size > maxBytes) {
    throw new Error(`media too large: ${meta.file_size} > ${maxBytes}`);
  }

  const url = new URL(meta.url);
  if (url.protocol !== 'https:' || !/(^|\.)(fbcdn\.net|facebook\.com)$/.test(url.hostname)) {
    // The URL comes from an API response, but it is still remote input.
    throw new Error(`refusing to download media from ${url.hostname}`);
  }

  const response = await fetch(url, {
    headers: auth,
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`meta media download failed: ${response.status}`);

  const declaredContentType =
    response.headers.get('content-type')?.split(';')[0]?.trim() ??
    meta.mime_type ??
    'application/octet-stream';
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > maxBytes) throw new Error(`media too large: ${declaredLength} > ${maxBytes}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`media too large: ${bytes.byteLength} > ${maxBytes}`);

  return { bytes, declaredContentType };
}

/** One inbound message, flattened out of Meta's nested webhook envelope. */
export interface MetaInboundMessage {
  providerSid: string;
  fromE164: string;
  text: string | null;
  lat: number | null;
  lng: number | null;
  mediaId: string | null;
  mediaContentType: string | null;
  modality: 'text' | 'audio' | 'image' | 'location' | 'sticker';
}

export interface MetaStatusUpdate {
  providerSid: string;
  status: string;
}

interface MetaWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<Record<string, never> & Record<string, unknown>>;
        statuses?: Array<Record<string, unknown>>;
      };
    }>;
  }>;
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Flattens the webhook envelope into the messages and statuses it carries.
 *
 * Meta batches: one POST can hold several entries, each with several changes,
 * each with several messages. Everything is read defensively, because this is remote
 * input, and a shape we do not recognise must be skipped rather than throw.
 */
export function parseMetaWebhook(body: unknown): {
  messages: MetaInboundMessage[];
  statuses: MetaStatusUpdate[];
} {
  const messages: MetaInboundMessage[] = [];
  const statuses: MetaStatusUpdate[] = [];

  for (const entry of (body as MetaWebhookBody)?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const raw of change.value?.messages ?? []) {
        const message = raw as Record<string, any>;
        const id = typeof message.id === 'string' ? message.id : '';
        const from = typeof message.from === 'string' ? message.from : '';
        if (!id || !from) continue;

        const type = typeof message.type === 'string' ? message.type : 'text';
        const media = message[type] as Record<string, unknown> | undefined;
        const isMedia = type === 'audio' || type === 'image' || type === 'voice' || type === 'sticker';

        messages.push({
          providerSid: id,
          fromE164: from.startsWith('+') ? from : `+${from}`,
          text:
            typeof message.text?.body === 'string'
              ? message.text.body
              : typeof media?.caption === 'string'
                ? (media.caption as string)
                : null,
          lat: asNumber(message.location?.latitude),
          lng: asNumber(message.location?.longitude),
          mediaId: isMedia && typeof media?.id === 'string' ? (media.id as string) : null,
          mediaContentType: isMedia && typeof media?.mime_type === 'string' ? (media.mime_type as string) : null,
          modality:
            message.location
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

      for (const raw of change.value?.statuses ?? []) {
        const status = raw as Record<string, unknown>;
        if (typeof status.id === 'string' && typeof status.status === 'string') {
          statuses.push({ providerSid: status.id, status: status.status });
        }
      }
    }
  }

  return { messages, statuses };
}
