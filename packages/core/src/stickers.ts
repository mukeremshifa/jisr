import { stripInvisible } from './invisible';

/**
 * F1 — tap-to-report. A sticker encodes a wa.me link that pre-fills `JISR-<CODE>`
 * so the worker only presses send. The code adds *context*, never access.
 */

const STICKER_RE = /^JISR-([A-Z0-9-]{2,10})$/;

/** Returns the uppercase asset code, or null when the message is not a sticker message. */
export function parseStickerCode(text: string | null | undefined): string | null {
  if (!text) return null;
  // WhatsApp clients add invisible marks and stray whitespace around pre-filled text.
  const cleaned = stripInvisible(text).trim().toUpperCase();
  const match = STICKER_RE.exec(cleaned);
  return match ? match[1]! : null;
}

export function isStickerMessage(text: string | null | undefined): boolean {
  return parseStickerCode(text) !== null;
}

/** The URL printed as a QR code on the sticker sheet. */
export function stickerUrl(whatsappNumberDigits: string, code: string): string {
  const digits = whatsappNumberDigits.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(`JISR-${code.toUpperCase()}`)}`;
}

/** A pending sticker is worth 15 minutes of context and no more. */
export const PENDING_ASSET_TTL_MS = 15 * 60 * 1000;

export function pendingAssetExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + PENDING_ASSET_TTL_MS);
}

export function isPendingAssetValid(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return expiresAt != null && expiresAt.getTime() > now.getTime();
}

/** Asset codes are 2–10 chars of [A-Z0-9-]; validated before anything is stored. */
export function isValidAssetCode(code: string): boolean {
  return /^[A-Z0-9-]{2,10}$/.test(code);
}
