import { mkdir, writeFile } from 'node:fs/promises';
import { synthesizeSpeech } from '@jisr/ai';
import { LANGUAGES, config } from '@jisr/core';

/**
 * C8. Fills in the language matrix by ear.
 *
 * Renders the same sentence through both speech providers for every language and
 * writes the files to ./tmp/. A human listens and sets `ttsProvider` and `voice`
 * in packages/core/src/languages.ts. Nobody can tell from a config file which
 * voice a Malayalam speaker will actually understand.
 *
 *   pnpm language-test
 */

/** One sentence with a time, a place and a common term, because those are what break. */
const SAMPLES: Record<string, string> = {
  en: 'The bus to Site B leaves at 4:30 today. Your OT for August is being checked.',
  hi: 'साइट बी की बस आज शाम 4:30 बजे निकलेगी। आपका अगस्त का OT जांचा जा रहा है।',
  ur: 'سائٹ بی کی بس آج شام 4:30 بجے روانہ ہوگی۔ آپ کا اگست کا OT چیک کیا جا رہا ہے۔',
  ml: 'സൈറ്റ് ബി യിലേക്കുള്ള ബസ് ഇന്ന് വൈകുന്നേരം 4:30 ന് പുറപ്പെടും. നിങ്ങളുടെ ഓഗസ്റ്റ് OT പരിശോധിക്കുന്നു.',
  tl: 'Aalis ang bus papuntang Site B ngayong 4:30 ng hapon. Sinusuri na ang OT mo para sa Agosto.',
  bn: 'সাইট বি-র বাস আজ বিকেল ৪:৩০ টায় ছাড়বে। আপনার অগাস্ট মাসের OT দেখা হচ্ছে।',
  ne: 'साइट बी जाने बस आज बेलुका ४:३० बजे जान्छ। तपाईंको अगस्टको OT जाँच हुँदैछ।',
  ar: 'حافلة الموقع ب تغادر اليوم الساعة 4:30 مساءً. يتم التحقق من ساعاتك الإضافية لشهر أغسطس.',
  ta: 'சைட் பி செல்லும் பேருந்து இன்று மாலை 4:30 மணிக்கு புறப்படும். உங்கள் ஆகஸ்ட் OT சரிபார்க்கப்படுகிறது.',
};

async function main(): Promise<void> {
  await mkdir('tmp/language-test', { recursive: true });

  const results: Array<{ language: string; provider: string; file: string | null; note: string }> = [];

  for (const entry of LANGUAGES) {
    const text = SAMPLES[entry.code] ?? SAMPLES.en!;

    // Render through the configured provider, then through the other one, so the
    // human hears the comparison rather than trusting the default.
    const providers = entry.ttsProvider === 'google' ? ['google', 'openai'] : ['openai', 'google'];

    for (const provider of providers) {
      if (provider === 'google' && !config.GOOGLE_CLOUD_PROJECT) {
        results.push({ language: entry.code, provider, file: null, note: 'GOOGLE_CLOUD_PROJECT not set' });
        continue;
      }
      if (provider === 'openai' && !config.OPENAI_API_KEY) {
        results.push({ language: entry.code, provider, file: null, note: 'OPENAI_API_KEY not set' });
        continue;
      }

      try {
        // synthesizeSpeech routes by the matrix, so force the provider by asking
        // for the language whose matrix entry names it.
        const speech = await synthesizeSpeech({
          text,
          language: provider === entry.ttsProvider ? entry.code : 'en',
        });
        const file = `tmp/language-test/${entry.code}-${speech.provider}-${speech.voice}.ogg`;
        await writeFile(file, speech.bytes);
        results.push({ language: entry.code, provider: speech.provider, file, note: 'ok' });
      } catch (error) {
        results.push({
          language: entry.code,
          provider,
          file: null,
          note: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  process.stdout.write('\nLanguage matrix check\n');
  process.stdout.write('language  provider   file / problem\n');
  for (const row of results) {
    process.stdout.write(
      `${row.language.padEnd(9)} ${row.provider.padEnd(10)} ${row.file ?? row.note}\n`,
    );
  }
  process.stdout.write(
    '\nListen to both files per language, then set ttsProvider and voice in\npackages/core/src/languages.ts.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
