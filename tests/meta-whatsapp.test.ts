import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Meta Cloud API front door. Same rule as the Twilio one: the interesting
 * cases are the wrong ones, because that is where a webhook handler either fails
 * closed or quietly lets something through.
 *
 * The module is imported fresh in each block because config is read at import
 * time.
 */

const originalEnv = { ...process.env };
const SECRET = 'test-app-secret-not-a-real-secret';

// The first dynamic import of @jisr/integrations pulls in the cloud SDKs and can
// take several seconds on a cold transform, which overruns the default timeout
// when the suite runs in parallel.
const IMPORT_TIMEOUT_MS = 30_000;

async function loadWithSecret(secret?: string) {
  vi.resetModules();
  if (secret === undefined) delete process.env.META_APP_SECRET;
  else process.env.META_APP_SECRET = secret;
  return import('@jisr/integrations');
}

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('Meta signature validation fails closed', () => {
  it('rejects when no app secret is configured, rather than throwing', async () => {
    const { validateMetaSignature } = await loadWithSecret(undefined);
    const check = validateMetaSignature({ signature: sign('{}'), rawBody: '{}' });
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('not_configured');
  }, IMPORT_TIMEOUT_MS);

  it('rejects a missing signature header', async () => {
    const { validateMetaSignature } = await loadWithSecret(SECRET);
    const check = validateMetaSignature({ signature: undefined, rawBody: '{}' });
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('missing_signature');
  }, IMPORT_TIMEOUT_MS);

  it('accepts a signature computed over the exact raw body', async () => {
    const { validateMetaSignature } = await loadWithSecret(SECRET);
    const body = '{"entry":[{"id":"1"}]}';
    expect(validateMetaSignature({ signature: sign(body), rawBody: body }).valid).toBe(true);
  }, IMPORT_TIMEOUT_MS);

  it('rejects when the body changed by a single byte', async () => {
    const { validateMetaSignature } = await loadWithSecret(SECRET);
    const body = '{"entry":[{"id":"1"}]}';
    const check = validateMetaSignature({ signature: sign(body), rawBody: body + ' ' });
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('mismatch');
  }, IMPORT_TIMEOUT_MS);

  it('rejects a signature made with a different secret', async () => {
    const { validateMetaSignature } = await loadWithSecret(SECRET);
    const body = '{"a":1}';
    expect(validateMetaSignature({ signature: sign(body, 'other'), rawBody: body }).valid).toBe(false);
  }, IMPORT_TIMEOUT_MS);

  it('rejects a malformed signature without throwing on the length mismatch', async () => {
    const { validateMetaSignature } = await loadWithSecret(SECRET);
    const check = validateMetaSignature({ signature: 'sha256=short', rawBody: '{}' });
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('mismatch');
  }, IMPORT_TIMEOUT_MS);
});

describe('Meta webhook verification handshake', () => {
  beforeEach(() => {
    process.env.META_VERIFY_TOKEN = 'verify-me';
  });

  it('echoes the challenge when the token matches', async () => {
    vi.resetModules();
    const { verifyWebhookChallenge } = await import('@jisr/integrations');
    expect(
      verifyWebhookChallenge({ mode: 'subscribe', token: 'verify-me', challenge: '12345' }),
    ).toBe('12345');
  }, IMPORT_TIMEOUT_MS);

  it('refuses a wrong token', async () => {
    vi.resetModules();
    const { verifyWebhookChallenge } = await import('@jisr/integrations');
    expect(
      verifyWebhookChallenge({ mode: 'subscribe', token: 'guessed', challenge: '12345' }),
    ).toBeNull();
  }, IMPORT_TIMEOUT_MS);
});

describe('Meta webhook parsing', () => {
  it('flattens a text message out of the batch envelope', async () => {
    vi.resetModules();
    const { parseMetaWebhook } = await import('@jisr/integrations');
    const { messages } = parseMetaWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'wamid.ABC', from: '971521313254', type: 'text', text: { body: 'no water' } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      providerSid: 'wamid.ABC',
      // The sender arrives without a plus and must be normalised to E.164.
      fromE164: '+971521313254',
      text: 'no water',
      modality: 'text',
      mediaId: null,
    });
  }, IMPORT_TIMEOUT_MS);

  it('carries the media id and type for a voice note', async () => {
    vi.resetModules();
    const { parseMetaWebhook } = await import('@jisr/integrations');
    const { messages } = parseMetaWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.AUD',
                    from: '971500000000',
                    type: 'audio',
                    audio: { id: 'media-123', mime_type: 'audio/ogg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages[0]).toMatchObject({
      modality: 'audio',
      mediaId: 'media-123',
      mediaContentType: 'audio/ogg',
    });
  }, IMPORT_TIMEOUT_MS);

  it('reads a location pin', async () => {
    vi.resetModules();
    const { parseMetaWebhook } = await import('@jisr/integrations');
    const { messages } = parseMetaWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.LOC',
                    from: '971500000000',
                    type: 'location',
                    location: { latitude: 25.1279, longitude: 55.2323 },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages[0]).toMatchObject({ modality: 'location', lat: 25.1279, lng: 55.2323 });
  }, IMPORT_TIMEOUT_MS);

  it('separates delivery statuses from messages', async () => {
    vi.resetModules();
    const { parseMetaWebhook } = await import('@jisr/integrations');
    const { messages, statuses } = parseMetaWebhook({
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered' }] } }] }],
    });
    expect(messages).toHaveLength(0);
    expect(statuses).toEqual([{ providerSid: 'wamid.X', status: 'delivered' }]);
  }, IMPORT_TIMEOUT_MS);

  it('skips entries it does not recognise instead of throwing', async () => {
    vi.resetModules();
    const { parseMetaWebhook } = await import('@jisr/integrations');
    // Remote input: a shape we do not understand must not take the batch down.
    expect(parseMetaWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseMetaWebhook({ entry: [{ changes: [{ value: {} }] }] })).toEqual({
      messages: [],
      statuses: [],
    });
    const { messages } = parseMetaWebhook({
      entry: [{ changes: [{ value: { messages: [{ type: 'text' }] } }] }],
    });
    // No id and no sender: nothing we can act on.
    expect(messages).toHaveLength(0);
  }, IMPORT_TIMEOUT_MS);
});
