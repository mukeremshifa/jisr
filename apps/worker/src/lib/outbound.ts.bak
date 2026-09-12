import { synthesizeSpeech } from '@jisr/ai';
import {
  UNSUPPORTED_MEDIA_REPLY,
  config,
  languageOf,
  log,
  sanitizeText,
} from '@jisr/core';
import { decryptField, repo, withTenant } from '@jisr/db';
import { sendWhatsApp, signedUrl, uploadMedia } from '@jisr/integrations';

/**
 * Everything Jisr says to a worker goes through here.
 *
 *   text -> speech in their language -> OGG/Opus -> private GCS -> a signed URL
 *   that Twilio can fetch for an hour -> one WhatsApp message carrying the voice
 *   note and the same words as text underneath.
 *
 * The phone number is decrypted here and nowhere else, and it is never logged.
 */

export interface SendToWorkerInput {
  companyId: string;
  workerId: string;
  /** The words the worker hears and reads, in their language. */
  textOriginal: string;
  /** The same thing in English, for the case record. */
  textEn?: string;
  language?: string;
  caseId?: string | null;
  /** Text-only: used for the very first notice and for failure messages. */
  voice?: boolean;
}

export interface SendResult {
  providerSid: string | null;
  mediaId: string | null;
}

export async function sendToWorker(input: SendToWorkerInput): Promise<SendResult> {
  const text = sanitizeText(input.textOriginal, 900);
  if (!text) return { providerSid: null, mediaId: null };

  const worker = await withTenant(input.companyId, ({ tx }) =>
    repo(input.companyId, tx).workerById(input.workerId),
  );
  if (!worker) {
    log.warn('send_to_worker_unknown', { workerId: input.workerId });
    return { providerSid: null, mediaId: null };
  }

  const language = input.language ?? worker.language;
  let mediaId: string | null = null;
  let mediaUrl: string | undefined;

  if (input.voice !== false) {
    try {
      const speech = await synthesizeSpeech({ text, language });
      const uploaded = await uploadMedia({
        bytes: speech.bytes,
        contentType: speech.contentType,
        extension: speech.extension,
      });
      const media = await withTenant(input.companyId, ({ tx }) =>
        repo(input.companyId, tx).insertMedia({
          gcsKey: uploaded.gcsKey,
          contentType: speech.contentType,
          bytes: speech.bytes.byteLength,
          sha256: '',
          kind: 'audio_out',
          durationSeconds: null,
        }),
      );
      mediaId = media.id;
      // Twilio fetches this URL itself, so it lives longer than a dashboard link.
      mediaUrl = await signedUrl(uploaded.gcsKey, 'twilio');
    } catch (error) {
      // Text still goes out. A worker who cannot read gets less, but they get
      // something, and the failure is visible in the logs rather than silent.
      log.error('voice_note_failed_sending_text_only', { language, error });
    }
  }

  // The one place a phone number is decrypted.
  const phone = decryptField(Buffer.from(worker.phoneEnc), 'data');
  const statusCallbackUrl = config.PUBLIC_GATEWAY_URL
    ? `${config.PUBLIC_GATEWAY_URL.replace(/\/+$/, '')}/webhooks/twilio/status`
    : undefined;

  const sent = await sendWhatsApp({
    toE164: phone,
    body: text,
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(statusCallbackUrl ? { statusCallbackUrl } : {}),
  });

  await withTenant(input.companyId, ({ tx }) =>
    repo(input.companyId, tx).insertMessage({
      caseId: input.caseId ?? null,
      workerId: input.workerId,
      direction: 'outbound',
      channel: 'whatsapp',
      modality: mediaId ? 'audio' : 'text',
      providerSid: sent.sid,
      language,
      textOriginal: text,
      textEn: input.textEn ?? null,
      mediaId,
      status: sent.status,
    }),
  );

  log.info('worker_message_sent', {
    workerRef: worker.publicRef,
    language,
    voice: Boolean(mediaId),
    caseId: input.caseId ?? null,
  });

  return { providerSid: sent.sid, mediaId };
}

/**
 * Speak-up outbound. The worker id comes from the sealed identity and is used
 * only to address the message — it is never written to the case, the logs or
 * Slack.
 */
export async function sendToSealedReporter(input: {
  companyId: string;
  caseId: string;
  textOriginal: string;
  language: string;
}): Promise<void> {
  const sealed = await withTenant(input.companyId, ({ tx }) =>
    repo(input.companyId, tx).sealedIdentity(input.caseId),
  );
  if (!sealed) {
    log.error('speakup_relay_no_sealed_identity', { caseId: input.caseId });
    return;
  }

  const workerId = decryptField(Buffer.from(sealed.reporterWorkerIdEnc), 'sealing');

  await sendToWorker({
    companyId: input.companyId,
    workerId,
    textOriginal: input.textOriginal,
    language: input.language,
    // Deliberately not linked to the case: a message row with both the worker id
    // and the case id would undo the sealing.
    caseId: null,
  });
}

export const UNSUPPORTED_MEDIA = UNSUPPORTED_MEDIA_REPLY;

/** The language a worker-facing string should be rendered in, with a safe default. */
export function resolveLanguage(preferred: string | null | undefined, fallback: string): string {
  return languageOf(preferred ?? fallback).code;
}
