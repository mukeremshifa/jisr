import { BIDI_RE, CONTROL_RE } from './invisible';

/**
 * Input normalisation at every boundary: NFC, control characters stripped,
 * length capped. Text is stored as text, never as HTML.
 */
export function sanitizeText(input: string | null | undefined, maxLength = 4000): string {
  if (!input) return '';
  return input
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .trim()
    .slice(0, maxLength);
}

/** WhatsApp sender ids arrive as `whatsapp:+9715...`. Keep only E.164 digits. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function isPlausibleE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

/** A transcript this poor is not worth a model call - we ask the worker to repeat. */
export function isUnreliableTranscript(text: string): boolean {
  const cleaned = sanitizeText(text);
  if (cleaned.length < 3) return true;
  const letters = cleaned.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length < 3) return true;
  // A single repeated character is not speech.
  if (/^(.)\1+$/.test(letters)) return true;
  return false;
}
