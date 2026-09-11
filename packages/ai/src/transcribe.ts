import OpenAI from 'openai';
import { NotConfiguredError, config, log, models, sanitizeText } from '@jisr/core';

/**
 * Speech in. The worker's roster language is passed as a hint so a short, noisy
 * voice note in Malayalam is not "detected" as English.
 */

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (client) return client;
  if (!config.OPENAI_API_KEY) throw new NotConfiguredError('OPENAI_API_KEY');
  client = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });
  return client;
}

export interface TranscriptionResult {
  text: string;
  /** What the model believes it heard, when it reports one. */
  detectedLanguage: string | null;
  durationSeconds: number | null;
}

export async function transcribeAudio(input: {
  bytes: Buffer;
  contentType: string;
  filename: string;
  /** ISO 639-1 hint from the worker's profile. */
  languageHint?: string;
}): Promise<TranscriptionResult> {
  const file = new File([new Uint8Array(input.bytes)], input.filename, { type: input.contentType });

  const response = await getClient().audio.transcriptions.create({
    file,
    model: models.transcribe,
    ...(input.languageHint ? { language: input.languageHint } : {}),
    response_format: 'verbose_json',
  });

  const asRecord = response as unknown as {
    text?: string;
    language?: string;
    duration?: number;
  };

  const text = sanitizeText(asRecord.text ?? '', 4000);
  log.info('transcription_done', {
    chars: text.length,
    hint: input.languageHint ?? null,
    detected: asRecord.language ?? null,
  });

  return {
    text,
    detectedLanguage: asRecord.language ?? null,
    durationSeconds: typeof asRecord.duration === 'number' ? Math.ceil(asRecord.duration) : null,
  };
}
