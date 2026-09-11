/**
 * Deterministic redaction. This runs *after* the LLM redaction pass as a belt-and-braces
 * layer: regexes cannot be talked out of matching.
 */

/** 784-YYYY-NNNNNNN-C, with or without dashes/spaces. */
const EMIRATES_ID_RE = /\b784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d\b/g;
/** UAE IBAN: AE + 21 digits. */
const UAE_IBAN_RE = /\bAE\d{21}\b/gi;
/**
 * Phone-ish runs: +971..., 05x..., or any 9–15 digit run with separators.
 * Deliberately greedy — a false positive costs a masked number, a false negative
 * costs a reporter's anonymity.
 */
const PHONE_RE = /(?:\+|00)?\d[\d\s\-().]{7,18}\d/g;

export const MASK = {
  emiratesId: '[ID]',
  iban: '[IBAN]',
  phone: '[PHONE]',
} as const;

export interface RedactionResult {
  text: string;
  hits: { emiratesId: number; iban: number; phone: number };
}

export function redactPii(input: string): RedactionResult {
  let emiratesId = 0;
  let iban = 0;
  let phone = 0;

  // Order matters: Emirates ID and IBAN would otherwise be eaten by the phone regex.
  let text = input.replace(EMIRATES_ID_RE, () => {
    emiratesId++;
    return MASK.emiratesId;
  });
  text = text.replace(UAE_IBAN_RE, () => {
    iban++;
    return MASK.iban;
  });
  text = text.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    // Years, hours, small numbers and money are not phone numbers.
    if (digits.length < 9 || digits.length > 15) return match;
    phone++;
    return MASK.phone;
  });

  return { text, hits: { emiratesId, iban, phone } };
}

export function hasPii(input: string): boolean {
  const { hits } = redactPii(input);
  return hits.emiratesId + hits.iban + hits.phone > 0;
}

/**
 * Data minimisation: never send a phone number to a model. Applied to every
 * model input, not just speak-up.
 */
export function scrubForModel(input: string): string {
  return redactPii(input).text;
}
