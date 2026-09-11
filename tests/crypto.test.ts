import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, hashToken, phoneHmac, safeEqualHex, sha256Hex } from '@jisr/db';

/** Keys come from vitest.config.ts, so these run without a developer's .env. */

describe('field encryption', () => {
  it('round-trips a phone number', () => {
    const sealed = encryptField('+15550100001', 'data');
    expect(decryptField(sealed, 'data')).toBe('+15550100001');
  });

  it('produces a different ciphertext every time (random IV)', () => {
    const a = encryptField('+15550100001', 'data');
    const b = encryptField('+15550100001', 'data');
    expect(a.equals(b)).toBe(false);
    expect(decryptField(a, 'data')).toBe(decryptField(b, 'data'));
  });

  it('refuses a ciphertext sealed under the other key', () => {
    // A leaked data key must not unseal a speak-up identity.
    const sealed = encryptField('worker-id', 'sealing');
    expect(() => decryptField(sealed, 'data')).toThrow();
  });

  it('refuses a tampered ciphertext instead of returning garbage', () => {
    const sealed = encryptField('+15550100001', 'data');
    sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 0xff;
    expect(() => decryptField(sealed, 'data')).toThrow();
  });

  it('refuses a truncated ciphertext', () => {
    expect(() => decryptField(Buffer.alloc(8), 'data')).toThrow();
  });
});

describe('phone lookup', () => {
  it('is deterministic, so a number can be found', () => {
    expect(phoneHmac('+15550100001')).toBe(phoneHmac('+15550100001'));
  });

  it('differs per number and reveals nothing about it', () => {
    const a = phoneHmac('+15550100001');
    const b = phoneHmac('+15550100002');
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
    expect(a).not.toContain('5550100001');
  });

  it('ignores surrounding whitespace', () => {
    expect(phoneHmac('  +15550100001 ')).toBe(phoneHmac('+15550100001'));
  });
});

describe('reporter tokens and digests', () => {
  it('hashes a reporter token one way', () => {
    const hash = hashToken('some-random-token');
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain('some-random-token');
    expect(hashToken('some-random-token')).toBe(hash);
  });

  it('compares hex digests without leaking length differences', () => {
    const a = sha256Hex('x');
    expect(safeEqualHex(a, a)).toBe(true);
    expect(safeEqualHex(a, sha256Hex('y'))).toBe(false);
    expect(safeEqualHex(a, '')).toBe(false);
  });
});
