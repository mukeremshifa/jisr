import OpenAI from 'openai';
import textToSpeech from '@google-cloud/text-to-speech';
import { NotConfiguredError, config, languageOf, log, models } from '@jisr/core';

/**
 * Speech out. The language matrix decides which engine speaks which language
 * (`packages/core/languages.ts`), so adding a language is a data change.
 *
 * Output is OGG/Opus because that is what WhatsApp plays back as a voice note
 * rather than as a file attachment.
 */

export interface SpeechResult {
  bytes: Buffer;
  contentType: string;
  extension: string;
  provider: 'openai' | 'google';
  voice: string;
}

let openai: OpenAI | undefined;
let google: InstanceType<typeof textToSpeech.TextToSpeechClient> | undefined;

export async function synthesizeSpeech(input: { text: string; language: string }): Promise<SpeechResult> {
  const entry = languageOf(input.language);
  const text = input.text.slice(0, 1200);

  if (entry.ttsProvider === 'google' && config.GOOGLE_CLOUD_PROJECT) {
    try {
      return await googleTts(text, entry.bcp47, entry.voice);
    } catch (error) {
      // A missing voice must not silence a worker: fall through to OpenAI and say so.
      log.warn('google_tts_failed_falling_back', { language: entry.code, error });
    }
  }

  return openAiTts(text, entry.voice, entry.code);
}

async function openAiTts(text: string, voice: string, language: string): Promise<SpeechResult> {
  if (!config.OPENAI_API_KEY) throw new NotConfiguredError('OPENAI_API_KEY');
  if (!openai) openai = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });

  const response = await openai.audio.speech.create({
    model: models.tts,
    voice: voice as never,
    input: text,
    response_format: 'opus',
  });

  const bytes = Buffer.from(await response.arrayBuffer());
  log.info('tts_done', { provider: 'openai', language, bytes: bytes.byteLength });
  return { bytes, contentType: 'audio/ogg', extension: 'ogg', provider: 'openai', voice };
}

async function googleTts(text: string, bcp47: string, voice: string): Promise<SpeechResult> {
  if (!google) {
    google = new textToSpeech.TextToSpeechClient(
      config.GOOGLE_CLOUD_PROJECT ? { projectId: config.GOOGLE_CLOUD_PROJECT } : {},
    );
  }

  const [response] = await google.synthesizeSpeech({
    input: { text },
    voice: { languageCode: bcp47, name: voice },
    audioConfig: { audioEncoding: 'OGG_OPUS' },
  });

  const content = response.audioContent;
  if (!content) throw new Error('google tts returned no audio');
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content as Uint8Array);

  log.info('tts_done', { provider: 'google', language: bcp47, voice, bytes: bytes.byteLength });
  return { bytes, contentType: 'audio/ogg', extension: 'ogg', provider: 'google', voice };
}

export function isTtsConfigured(): boolean {
  return Boolean(config.OPENAI_API_KEY || config.GOOGLE_CLOUD_PROJECT);
}
