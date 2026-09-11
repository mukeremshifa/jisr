/**
 * Invisible and formatting characters that must never survive into stored text,
 * a Slack block or a sticker code. Listed as code points so the source file stays
 * readable and greppable instead of holding characters nobody can see.
 */

// Zero-width space/non-joiner/joiner, LTR+RTL marks, BOM.
const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff];
// Bidirectional embedding/override/isolate controls.
const BIDI = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

const charClass = (points: readonly number[]) =>
  `[${points.map((c) => String.fromCodePoint(c)).join('')}]`;

export const ZERO_WIDTH_RE = new RegExp(charClass(ZERO_WIDTH), 'g');
export const BIDI_RE = new RegExp(charClass(BIDI), 'g');
export const INVISIBLE_RE = new RegExp(charClass([...ZERO_WIDTH, ...BIDI]), 'g');

/** C0/C1 control characters, keeping tab and newline. */
export const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE_RE, '');
}
