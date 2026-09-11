import { describe, expect, it } from 'vitest';
import { audit } from '@jisr/db';
import { validateTwilioSignature, verifySlackSignature } from '@jisr/integrations';

/**
 * The gateway's front door, tested for what it does when things are *wrong*:
 * that is where a webhook handler either fails closed or quietly lets something
 * through.
 */

describe('Twilio signature validation fails closed', () => {
  it('rejects when no auth token is configured, rather than throwing', () => {
    // No TWILIO_AUTH_TOKEN in the test environment. A misconfigured deployment
    // must reject webhooks and say why, not answer 500 and leak a stack.
    const check = validateTwilioSignature({
      signature: 'anything',
      url: 'https://example.test/webhooks/twilio/whatsapp',
      params: { MessageSid: 'SM1' },
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('not_configured');
  });

  it('rejects a request with no signature header at all', () => {
    const check = validateTwilioSignature({
      signature: undefined,
      url: 'https://example.test/webhooks/twilio/whatsapp',
      params: {},
    });
    expect(check.valid).toBe(false);
  });
});

describe('Slack signature verification', () => {
  it('rejects when no signing secret is configured', () => {
    expect(
      verifySlackSignature({ signature: 'v0=abc', timestamp: '1', rawBody: 'payload={}' }),
    ).toBe(false);
  });

  it('rejects a missing signature or timestamp', () => {
    expect(verifySlackSignature({ signature: undefined, timestamp: '1', rawBody: '' })).toBe(false);
    expect(verifySlackSignature({ signature: 'v0=abc', timestamp: undefined, rawBody: '' })).toBe(false);
  });
});

describe('audit writes never take down the request they describe', () => {
  it('resolves even with no database configured', async () => {
    // DATABASE_URL is unset in tests. The insert fails; the call must not.
    await expect(
      audit({ event: 'twilio_signature_invalid', severity: 'warn', details: { reason: 'test' } }),
    ).resolves.toBeUndefined();
  });
});
