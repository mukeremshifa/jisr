import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigError } from '@jisr/core';

/**
 * Application-level field encryption.
 *
 * Layout: [12-byte IV][16-byte auth tag][ciphertext]. One buffer, one column,
 * no separate IV/tag bookkeeping to get wrong.
 *
 * Two independent keys, loaded from Secret Manager in production:
 *  - DATA_ENCRYPTION_KEY seals worker phone numbers
 *  - SEALING_KEY seals speak-up reporter identities
 * Leaking one must not unseal the other, so they are never interchangeable.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type KeyName = 'data' | 'sealing' | 'phoneHmac';

const ENV_FOR_KEY: Record<KeyName, string> = {
  data: 'DATA_ENCRYPTION_KEY',
  sealing: 'SEALING_KEY',
  phoneHmac: 'PHONE_HMAC_KEY',
};

const cache = new Map<KeyName, Buffer>();

function loadKey(name: KeyName): Buffer {
  const cached = cache.get(name);
  if (cached) return cached;

  const envName = ENV_FOR_KEY[name];
  const raw = process.env[envName];
  if (!raw || raw.trim() === '') {
    throw new ConfigError(`${envName} is required for ${name} operations`, { envName });
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new ConfigError(`${envName} must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`, {
      envName,
    });
  }
  cache.set(name, key);
  return key;
}

/** Test-only hook: forget cached keys after changing the environment. */
export function resetKeyCache(): void {
  cache.clear();
}

export function encryptField(plaintext: string, keyName: Exclude<KeyName, 'phoneHmac'> = 'data'): Buffer {
  const key = loadKey(keyName);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptField(sealed: Buffer, keyName: Exclude<KeyName, 'phoneHmac'> = 'data'): string {
  const key = loadKey(keyName);
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // Throws on a tampered ciphertext, which is the behaviour we want: fail closed.
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * Deterministic lookup value for a phone number. A separate key from the
 * encryption key, so a lookup index cannot be turned into a decryption oracle.
 */
export function phoneHmac(phoneE164: string): string {
  const key = loadKey('phoneHmac');
  return createHmac('sha256', key).update(phoneE164.trim()).digest('hex');
}

/** Speak-up reporter token: only the hash is stored, so the token cannot be recovered. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
