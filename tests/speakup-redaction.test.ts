import { describe, expect, it } from 'vitest';
import { MASK, redactPii } from '@jisr/core';
import { decryptField, encryptField, hashToken } from '@jisr/db';

/**
 * F2, end to end over the parts that do not need a database.
 *
 * The order matters: the LLM pass removes what a regex cannot see (names, a room
 * number that points at one person), and the regex pass then masks what an LLM
 * might be talked out of masking. Whatever the model returns, the identifiers
 * below do not survive.
 */
describe('speak-up redaction, belt and braces', () => {
  it('masks identifiers even when the model pass leaves them in', () => {
    // Pretend the redaction model returned the reporter's details untouched.
    const modelOutput =
      'Rajesh Kumar (784-1990-1234567-1, +971501234567) says Site B works through the midday break.';

    const final = redactPii(modelOutput).text;

    expect(final).not.toContain('784-1990-1234567-1');
    expect(final).not.toContain('+971501234567');
    expect(final).toContain(MASK.emiratesId);
    expect(final).toContain(MASK.phone);
    // The substance survives: HR still learns what to act on.
    expect(final).toContain('Site B');
    expect(final).toContain('midday break');
  });

  it('masks a bank account someone volunteers in a pay report', () => {
    const final = redactPii('My salary goes to AE070331234567890123456').text;
    expect(final).toContain(MASK.iban);
    expect(final).not.toContain('AE070331234567890123456');
  });

  it('seals the reporter under the sealing key, not the data key', () => {
    const workerId = '7f3ka9c2-1111-2222-3333-444455556666';
    const sealed = encryptField(workerId, 'sealing');

    expect(decryptField(sealed, 'sealing')).toBe(workerId);
    // A leaked phone-encryption key does not unseal an identity.
    expect(() => decryptField(sealed, 'data')).toThrow();
    // The ciphertext itself reveals nothing.
    expect(sealed.toString('utf8')).not.toContain(workerId);
  });

  it('stores only a one-way hash of the reporter token', () => {
    const token = 'abc123-reporter-token';
    const stored = hashToken(token);

    expect(stored).toHaveLength(64);
    expect(stored).not.toContain(token);
    // Deterministic, so a later message from the same reporter finds the case.
    expect(hashToken(token)).toBe(stored);
    expect(hashToken(`${token}x`)).not.toBe(stored);
  });
});
