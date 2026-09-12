import { randomBytes, randomUUID } from 'node:crypto';

/** Crockford-ish alphabet: no I, L, O, U, so it is unambiguous when read aloud or printed on a sticker. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Random, never sequential. Rejection sampling keeps the distribution uniform. */
export function randomCode(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Public case id shown to humans, e.g. JS-7F3K. */
export function newCasePublicId(): string {
  return `JS-${randomCode(4)}`;
}

/** 128-bit reporter token for speak-up. Only its SHA-256 hash is ever stored. */
export function newReporterToken(): string {
  return randomBytes(16).toString('base64url');
}

export function newUuid(): string {
  return randomUUID();
}

/** Opaque object key, so a bucket listing leaks nothing. */
export function newMediaKey(extension: string): string {
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const now = new Date();
  const day = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  return `media/${day}/${randomBytes(24).toString('hex')}.${safeExt}`;
}
