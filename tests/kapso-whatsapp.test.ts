import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Kapso carrier: signature checking and the webhook parser that normalises
 * Kapso's envelope into the shape the rest of the gateway already handles.
 */

const originalEnv = { ...process.env };
const SECRET = 'test-kapso-secret-not-a-real-secret';

// The first dynamic import of @jisr/integrations pulls in the cloud SDKs and can
// take several seconds on a cold transform.
const IMPORT_TIMEOUT_MS = 30_000;

async function loadWithSecret(secret?: string) {
  vi.resetModules();
  if (secret === undefined) delete process.env.KAPSO_WEBHOOK_SECRET;
  else process.env.KAPSO_WEBHOOK_SECRET = secret;
  return import('@jisr/integrations');
}

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** A single inbound text event, shaped as Kapso documents it. */
function inboundText(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      id: 'wamid.123',
      timestamp: '1730092800',
      type: 'text',
      from: '971521313254',
      text: { body: 'no water at block B' },
      kapso: { direction: 'inbound', status: 'received', has_media: false, content: 'no water at block B' },
      ...overrides,
    },
    conversation: { id: 'conv_123', phone_number: '971521313254' },
    phone_number_id: '123456789012345',
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('Kapso signature validation fails closed', () => {
  it('rejects when no webhook secret is configured, rather than throwing', async () => {
    const { validateKapsoSignature } = await loadWithSecret(undefined);
    const check = validateKapsoSignature({ signature: sign('{}'), rawBody: '{}' });
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('not_configured');
  }, IMPORT_TIMEOUT_MS);

  it('rejects a missing signature header', async () => {
    const { validateKapsoSignature } = await loadWithSecret(SECRET);
    const check = validateKapsoSignature({ signature: undefined, rawBody: '{}' });
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('missing_signature');
  }, IMPORT_TIMEOUT_MS);

  it('accepts bare hex computed over the exact raw body', async () => {
    const { validateKapsoSignature } = await loadWithSecret(SECRET);
    const body = JSON.stringify(inboundText());
    expect(validateKapsoSignature({ signature: sign(body), rawBody: body }).valid).toBe(true);
  }, IMPORT_TIMEOUT_MS);

  it('tolerates a sha256= prefix on the signature', async () => {
    const { validateKapsoSignature } = await loadWithSecret(SECRET);
    const body = '{"a":1}';
    expect(
      validateKapsoSignature({ signature: `sha256=${sign(body)}`, rawBody: body }).valid,
    ).toBe(true);
  }, IMPORT_TIMEOUT_MS);

  it('rejects when the body changed by a single byte', async () => {
    const { validateKapsoSignature } = await loadWithSecret(SECRET);
    const body = '{"a":1}';
    const check = validateKapsoSignature({ signature: sign(body), rawBody: body + ' ' });
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('mismatch');
  }, IMPORT_TIMEOUT_MS);

  it('rejects a signature made with a different secret', async () => {
    const { validateKapsoSignature } = await loadWithSecret(SECRET);
    const body = '{"a":1}';
    expect(validateKapsoSignature({ signature: sign(body, 'other'), rawBody: body }).valid).toBe(false);
  }, IMPORT_TIMEOUT_MS);
});

describe('Kapso webhook parsing', () => {
  it('normalises a single inbound text event', async () => {
    vi.resetModules();
    const { parseKapsoWebhook } = await import('@jisr/integrations');
    const { messages } = parseKapsoWebhook(inboundText());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      providerSid: 'wamid.123',
      // Arrives without a plus and must be normalised to E.164.
      fromE164: '+971521313254',
      text: 'no water at block B',
      modality: 'text',
      mediaId: null,
    });
  }, IMPORT_TIMEOUT_MS);

  it('unwraps a buffered batch into its events', async () => {
    vi.resetModules();
    const { parseKapsoWebhook } = await import('@jisr/integrations');
    const { messages } = parseKapsoWebhook({
      type: 'whatsapp.message.received',
      batch: true,
      data: [inboundText(), inboundText({ id: 'wamid.456', text: { body: 'second' } })],
      batch_info: { size: 2 },
    });
    expect(messages.map((m) => m.providerSid)).toEqual(['wamid.123', 'wamid.456']);
  }, IMPORT_TIMEOUT_MS);

  it('carries the media url and content type for a voice note', async () => {
    vi.resetModules();
    const { parseKapsoWebhook } = await import('@jisr/integrations');
    const { messages } = parseKapsoWebhook(
      inboundText({
        type: 'audio',
        text: undefined,
        audio: { mime_type: 'audio/ogg' },
        kapso: {
          direction: 'inbound',
          has_media: true,
          media_url: 'https://media.kapso.ai/abc.ogg',
          media_data: { content_type: 'audio/ogg', byte_size: 1024 },
        },
      }),
    );
    expect(messages[0]).toMatchObject({
      modality: 'audio',
      // Kapso hands over a ready URL rather than an id to resolve.
      mediaId: 'https://media.kapso.ai/abc.ogg',
      mediaContentType: 'audio/ogg',
    });
  }, IMPORT_TIMEOUT_MS);

  it('reads a location pin', async () => {
    vi.resetModules();
    const { parseKapsoWebhook } = await import('@jisr/integrations');
    const { messages } = parseKapsoWebhook(
      inboundText({ type: 'location', location: { latitude: 25.1279, longitude: 55.2323 } }),
    );
    expect(messages[0]).toMatchObject({ modality: 'location', lat: 25.1279, lng: 55.2323 });
  }, IMPORT_TIMEOUT_MS);

  it('treats an outbound echo as a delivery status, not a new message', async () => {
    vi.resetModules();
    const { parseKapsoWebhook } = await import('@jisr/integrations');
    const { messages, statuses } = parseKapsoWebhook(
      inboundText({ kapso: { direction: 'outbound', status: 'delivered' } }),
    );
    // Our own replies must never be re-ingested as worker reports.
    expect(messages).toHaveLength(0);
    expect(statuses).toEqual([{ providerSid: 'wamid.123', status: 'delivered' }]);
  }, IMPORT_TIMEOUT_MS);

  it('skips envelopes it does not recognise instead of throwing', async () => {
    vi.resetModules();
    const { parseKapsoWebhook } = await import('@jisr/integrations');
    expect(parseKapsoWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseKapsoWebhook({})).toEqual({ messages: [], statuses: [] });
    // No id: nothing we could act on or deduplicate.
    expect(parseKapsoWebhook({ message: { from: '971500000000' } }).messages).toHaveLength(0);
  }, IMPORT_TIMEOUT_MS);
});
