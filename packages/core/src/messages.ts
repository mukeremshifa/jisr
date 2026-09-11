import { UAE_EMERGENCY_NUMBERS } from './emergency';
import { DEFAULT_LANGUAGE } from './languages';

/**
 * Worker-facing copy.
 *
 * Most worker messages are produced by the model in the worker's language. These
 * are the exceptions: lines that must go out *immediately* (the emergency reply)
 * or *identically every time* (the privacy notice, the acknowledgement prompt).
 * They are translated ahead of time so no model call sits between a worker and
 * an ambulance number.
 *
 * These strings need a native-speaker review before a real deployment - see
 * docs/decisions.md.
 */

type Lang = string;

function pick(table: Record<string, string>, language: Lang): string {
  return table[language.toLowerCase().slice(0, 2)] ?? table[DEFAULT_LANGUAGE]!;
}

const EMERGENCY: Record<string, string> = {
  en: `Call ${UAE_EMERGENCY_NUMBERS.ambulance} now (ambulance). I have told the safety officer. Please send your location.`,
  hi: `अभी ${UAE_EMERGENCY_NUMBERS.ambulance} पर कॉल करें (एम्बुलेंस)। मैंने सुरक्षा अधिकारी को बता दिया है। अपना लोकेशन भेजें।`,
  ur: `ابھی ${UAE_EMERGENCY_NUMBERS.ambulance} پر کال کریں (ایمبولینس)۔ میں نے سیفٹی آفیسر کو بتا دیا ہے۔ اپنی لوکیشن بھیجیں۔`,
  ml: `ഉടൻ ${UAE_EMERGENCY_NUMBERS.ambulance} എന്ന നമ്പറിൽ വിളിക്കുക (ആംബുലൻസ്). ഞാൻ സേഫ്റ്റി ഓഫീസറെ അറിയിച്ചു. നിങ്ങളുടെ ലൊക്കേഷൻ അയക്കുക.`,
  tl: `Tumawag agad sa ${UAE_EMERGENCY_NUMBERS.ambulance} (ambulansya). Nasabihan ko na ang safety officer. Pakipadala ang iyong lokasyon.`,
  bn: `এখনই ${UAE_EMERGENCY_NUMBERS.ambulance} নম্বরে কল করুন (অ্যাম্বুলেন্স)। আমি সেফটি অফিসারকে জানিয়েছি। আপনার লোকেশন পাঠান।`,
  ne: `अहिले नै ${UAE_EMERGENCY_NUMBERS.ambulance} मा कल गर्नुहोस् (एम्बुलेन्स)। मैले सुरक्षा अधिकारीलाई भनिसकें। आफ्नो लोकेसन पठाउनुहोस्।`,
  ar: `اتصل الآن بالرقم ${UAE_EMERGENCY_NUMBERS.ambulance} (إسعاف). لقد أبلغت مسؤول السلامة. أرسل موقعك من فضلك.`,
  ta: `உடனே ${UAE_EMERGENCY_NUMBERS.ambulance} ஐ அழைக்கவும் (ஆம்புலன்ஸ்). நான் பாதுகாப்பு அதிகாரியிடம் தெரிவித்துவிட்டேன். உங்கள் இருப்பிடத்தை அனுப்புங்கள்.`,
};

/** Fire and police numbers, appended once so the worker has all three. */
const EMERGENCY_OTHER_NUMBERS = `${UAE_EMERGENCY_NUMBERS.civilDefence} = fire, ${UAE_EMERGENCY_NUMBERS.police} = police`;

export function emergencyReply(language: Lang): string {
  return `${pick(EMERGENCY, language)}\n(${EMERGENCY_OTHER_NUMBERS})`;
}

const ACK_PROMPT: Record<string, string> = {
  en: 'Reply OK or say yes when you have heard this.',
  hi: 'सुनने के बाद OK लिखें या "हाँ" बोलें।',
  ur: 'سننے کے بعد OK لکھیں یا "ہاں" بولیں۔',
  ml: 'കേട്ടശേഷം OK എന്ന് എഴുതുക അല്ലെങ്കിൽ "അതെ" എന്ന് പറയുക.',
  tl: 'Mag-reply ng OK o sabihin ang "oo" kapag narinig mo ito.',
  bn: 'শোনার পরে OK লিখুন বা "হ্যাঁ" বলুন।',
  ne: 'सुनेपछि OK लेख्नुहोस् वा "हो" भन्नुहोस्।',
  ar: 'أرسل OK أو قل "نعم" بعد سماع هذه الرسالة.',
  ta: 'கேட்ட பிறகு OK என எழுதுங்கள் அல்லது "ஆம்" என்று சொல்லுங்கள்.',
};

export function ackPrompt(language: Lang): string {
  return pick(ACK_PROMPT, language);
}

const YES_NO_PROMPT: Record<string, string> = {
  en: 'Is this right? Say yes or no.',
  hi: 'क्या यह सही है? हाँ या ना बोलिए।',
  ur: 'کیا یہ درست ہے؟ ہاں یا نہ بولیں۔',
  ml: 'ഇത് ശരിയാണോ? അതെ അല്ലെങ്കിൽ അല്ല എന്ന് പറയുക.',
  tl: 'Tama ba ito? Sabihin ang oo o hindi.',
  bn: 'এটা কি ঠিক? হ্যাঁ বা না বলুন।',
  ne: 'के यो सही हो? हो वा होइन भन्नुहोस्।',
  ar: 'هل هذا صحيح؟ قل نعم أو لا.',
  ta: 'இது சரியா? ஆம் அல்லது இல்லை என்று சொல்லுங்கள்.',
};

export function yesNoPrompt(language: Lang): string {
  return pick(YES_NO_PROMPT, language);
}

/** C7. Sent once, before anything else, on a worker's very first message. */
export function firstContactNotice(companyName: string): string {
  return [
    `I'm Jisr, ${companyName}'s assistant. I am not a person.`,
    'I pass your messages to your supervisor or HR and bring back their answers.',
    "Say 'anonymous' at any time to report without your name.",
  ].join(' ');
}

/** Unknown number: one short reply, then silence. Never reveals whether a number is on the roster. */
export function unknownSenderReply(companyName: string): string {
  return `This number is for ${companyName} staff. Please ask your supervisor to add you.`;
}

export const UNKNOWN_STICKER_REPLY = "I don't recognise this sticker. Tell me where you are.";

export const TRANSCRIPT_UNCLEAR_REPLY =
  "I couldn't hear that clearly. Please send it again as a voice note.";

export const AUDIO_TOO_LONG_REPLY = 'Please split this into shorter messages, under 3 minutes each.';

export const UNSUPPORTED_MEDIA_REPLY =
  'I can read photos and voice notes only. Please send a photo or speak your message.';

export const RATE_LIMITED_REPLY =
  "You've sent a lot of messages. I'll pick these up shortly - your supervisor has been told.";

export const BUDGET_TRIPPED_REPLY = 'HR will review this.';

/** Jisr never promises an outcome a manager has not decided. Used on every relay. */
export const NO_PROMISE_RULE =
  'Never promise an outcome, a payment, a date or a fix that a manager has not decided.';

/** Speak-up mode confirmation, before any report is collected (F2 step 1). */
export function speakupConfirmation(): string {
  return [
    'This report will be anonymous.',
    'Your name, your number and your voice will not be shown.',
    'Only HR will see it, and I can bring you their questions without telling them who you are.',
  ].join(' ');
}
