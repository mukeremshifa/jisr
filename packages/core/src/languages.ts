/**
 * The language matrix. One entry per language Jisr speaks.
 *
 * `ttsProvider` decides which speech engine renders the voice note. The humans
 * fill this in by listening to `scripts/language-test.ts` output. The values
 * below are the starting point, not a claim about quality.
 *
 * `transcriptionHint` is passed to the transcription model as the expected
 * language so a short, noisy voice note is not mis-detected.
 */
export type TtsProvider = 'openai' | 'google';

export interface LanguageEntry {
  /** ISO 639-1 */
  code: string;
  /** English name, for Slack cards and the dashboard */
  name: string;
  /** Endonym, for worker-facing UI */
  nativeName: string;
  script: string;
  rtl: boolean;
  ttsProvider: TtsProvider;
  /** OpenAI voice name, or a Google Cloud TTS voice name when provider is google */
  voice: string;
  /** ISO 639-1 hint for the transcription model */
  transcriptionHint: string;
  /** BCP-47 tag, needed by Google Cloud TTS */
  bcp47: string;
}

export const LANGUAGES: readonly LanguageEntry[] = [
  {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    script: 'Latn',
    rtl: false,
    ttsProvider: 'openai',
    voice: 'alloy',
    transcriptionHint: 'en',
    bcp47: 'en-US',
  },
  {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    script: 'Deva',
    rtl: false,
    ttsProvider: 'openai',
    voice: 'alloy',
    transcriptionHint: 'hi',
    bcp47: 'hi-IN',
  },
  {
    code: 'ur',
    name: 'Urdu',
    nativeName: 'اردو',
    script: 'Arab',
    rtl: true,
    ttsProvider: 'google',
    voice: 'ur-IN-Chirp3-HD-Achernar',
    transcriptionHint: 'ur',
    bcp47: 'ur-IN',
  },
  {
    code: 'ml',
    name: 'Malayalam',
    nativeName: 'മലയാളം',
    script: 'Mlym',
    rtl: false,
    ttsProvider: 'google',
    voice: 'ml-IN-Chirp3-HD-Achernar',
    transcriptionHint: 'ml',
    bcp47: 'ml-IN',
  },
  {
    code: 'tl',
    name: 'Tagalog',
    nativeName: 'Tagalog',
    script: 'Latn',
    rtl: false,
    ttsProvider: 'google',
    voice: 'fil-PH-Chirp3-HD-Achernar',
    transcriptionHint: 'tl',
    bcp47: 'fil-PH',
  },
  {
    code: 'bn',
    name: 'Bengali',
    nativeName: 'বাংলা',
    script: 'Beng',
    rtl: false,
    ttsProvider: 'google',
    voice: 'bn-IN-Chirp3-HD-Achernar',
    transcriptionHint: 'bn',
    bcp47: 'bn-IN',
  },
  {
    code: 'ne',
    name: 'Nepali',
    nativeName: 'नेपाली',
    script: 'Deva',
    rtl: false,
    ttsProvider: 'google',
    voice: 'ne-NP-Chirp3-HD-Achernar',
    transcriptionHint: 'ne',
    bcp47: 'ne-NP',
  },
  {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    script: 'Arab',
    rtl: true,
    ttsProvider: 'openai',
    voice: 'alloy',
    transcriptionHint: 'ar',
    bcp47: 'ar-XA',
  },
  {
    code: 'ta',
    name: 'Tamil',
    nativeName: 'தமிழ்',
    script: 'Taml',
    rtl: false,
    ttsProvider: 'google',
    voice: 'ta-IN-Chirp3-HD-Achernar',
    transcriptionHint: 'ta',
    bcp47: 'ta-IN',
  },
] as const;

export const DEFAULT_LANGUAGE = 'en';

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function languageOf(code: string | null | undefined): LanguageEntry {
  const entry = code ? BY_CODE.get(code.toLowerCase().slice(0, 2)) : undefined;
  // Falling back to English is a visible, safe default: the worker still gets a
  // message, and the card shows the detected language so a human can correct it.
  return entry ?? BY_CODE.get(DEFAULT_LANGUAGE)!;
}

export function isSupportedLanguage(code: string): boolean {
  return BY_CODE.has(code.toLowerCase().slice(0, 2));
}

export const SUPPORTED_LANGUAGE_CODES: readonly string[] = LANGUAGES.map((l) => l.code);
