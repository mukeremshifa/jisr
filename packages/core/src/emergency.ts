/**
 * C6 - the emergency pre-check. This runs *before* any model call so a life-safety
 * message never waits on an LLM. Keywords are deliberately broad: a false positive
 * costs one extra "call 998" message, a false negative costs much more.
 */

export const UAE_EMERGENCY_NUMBERS = {
  ambulance: '998',
  civilDefence: '997',
  police: '999',
} as const;

const KEYWORDS: readonly string[] = [
  // English
  'emergency', 'accident', 'ambulance', 'bleeding', 'blood', 'fire', 'unconscious',
  'not breathing', 'fell down', 'fallen', 'collapse', 'collapsed', 'electrocut',
  'trapped', 'heat stroke', 'heatstroke', 'dying', 'injured', 'injury',
  // Hindi / Nepali (Devanagari)
  'मदद', 'खून', 'दुर्घटना', 'आग', 'गिर गया', 'बेहोश', 'एम्बुलेंस', 'चोट',
  // Urdu
  'مدد', 'خون', 'حادثہ', 'آگ', 'بے ہوش', 'ایمبولینس', 'زخمی',
  // Arabic
  'مساعدة', 'حادث', 'دم', 'حريق', 'إسعاف', 'اسعاف', 'مصاب',
  // Malayalam
  'അപകടം', 'രക്തം', 'തീ', 'സഹായം',
  // Bengali
  'দুর্ঘটনা', 'রক্ত', 'আগুন', 'সাহায্য',
  // Tamil
  'விபத்து', 'இரத்தம்', 'தீ', 'உதவி',
  // Tagalog
  'aksidente', 'dugo', 'sunog', 'nahulog', 'nasaktan',
];

export interface EmergencyCheck {
  hit: boolean;
  matched: string[];
}

/** Substring matching, not word boundaries: these scripts do not use spaces the same way. */
export function emergencyKeywordCheck(text: string | null | undefined): EmergencyCheck {
  if (!text) return { hit: false, matched: [] };
  const haystack = text.toLowerCase();
  const matched = KEYWORDS.filter((k) => haystack.includes(k.toLowerCase()));
  return { hit: matched.length > 0, matched };
}

/** Keyword OR model flag. Either one is enough. */
export function isEmergency(text: string | null | undefined, modelFlag: boolean): boolean {
  return modelFlag || emergencyKeywordCheck(text).hit;
}
