import { synthesizeSpeech } from '@jisr/ai';
import {
  UNSUPPORTED_MEDIA_REPLY,
  config,
  languageOf,
  log,
  sanitizeText,
} from '@jisr/core';
import { decryptField, repo, withTenant } from '@jisr/db';
import {
  isGcsConfigured,
  sendWhatsAppMessage,
  signedUrl,
  supportsMediaUpload,
  uploadMedia,
  uploadWhatsAppMedia,
} from '@jisr/integrations';

/**
 * Everything Jisr says to a worker goes through here.
 *
 *   text -> speech in their language -> OGG/Opus -> the carrier's own media
 *   store (or private GCS, for a carrier that cannot host media) -> one WhatsApp
 *   message carrying the voice note and the same words as text underneath.
 *
 * Meta and Kapso accept an upload and hand back a media id; sending that id is
 * both what makes WhatsApp render a true voice note and what lets voice work
 * with no object storage configured. Twilio has no media endpoint and can only
 * fetch a URL, so it still needs GCS.
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
  let carrierMediaId: string | undefined;

  if (input.voice !== false) {
    try {
      const speech = await synthesizeSpeech({ text, language });

      // Where the audio lives. The carrier's own store is preferred: it renders
      // as a voice note and needs no bucket. GCS is the fallback for Twilio,
      // and the record it leaves is what lets the dashboard replay the audio.
      let gcsKey: string | null = null;
      if (supportsMediaUpload()) {
        carrierMediaId = await uploadWhatsAppMedia({
          bytes: speech.bytes,
          contentType: speech.contentType,
          filename: `voice.${speech.extension}`,
        });
      }
      if (!carrierMediaId || isGcsConfigured()) {
        const uploaded = await uploadMedia({
          bytes: speech.bytes,
          contentType: speech.contentType,
          extension: speech.extension,
        });
        gcsKey = uploaded.gcsKey;
        // Twilio fetches this URL itself, so it lives longer than a dashboard link.
        if (!carrierMediaId) mediaUrl = await signedUrl(uploaded.gcsKey, 'twilio');
      }

      // The media row is the dashboard's handle on the audio, and `gcs_key` is
      // NOT NULL, so a carrier-hosted note records the id it does have.
      const media = await withTenant(input.companyId, ({ tx }) =>
        repo(input.companyId, tx).insertMedia({
          gcsKey: gcsKey ?? `carrier:${config.WHATSAPP_PROVIDER}:${carrierMediaId}`,
          contentType: speech.contentType,
          bytes: speech.bytes.byteLength,
          sha256: '',
          kind: 'audio_out',
          durationSeconds: null,
        }),
      );
      mediaId = media.id;
    } catch (error) {
      // Text still goes out. A worker who cannot read gets less, but they get
      // something, and the failure is visible in the logs rather than silent.
      log.error('voice_note_failed_sending_text_only', { language, error });
    }
  }

  // The one place a phone number is decrypted.
  const phone = decryptField(Buffer.from(worker.phoneEnc), 'data');
  // Twilio only: Meta reports delivery on its own webhook and takes no callback
  // URL on the send.
  const statusCallbackUrl =
    config.WHATSAPP_PROVIDER === 'twilio' && config.PUBLIC_GATEWAY_URL
      ? `${config.PUBLIC_GATEWAY_URL.replace(/\/+$/, '')}/webhooks/twilio/status`
      : undefined;

  // The WhatsApp sandbox rejects free-form sends (error 21654: ContentSid
  // Required), which would otherwise abort intake before the case is ever
  // created. Delivery to the worker is best-effort: a send failure is recorded
  // on the message row and in the logs, and the case still reaches a human.
  let sent: { sid: string | null; status: string };
  try {
    sent = await sendWhatsAppMessage({
      toE164: phone,
      body: text,
      ...(carrierMediaId ? { mediaId: carrierMediaId } : {}),
      ...(mediaUrl ? { mediaUrl } : {}),
      ...(statusCallbackUrl ? { statusCallbackUrl } : {}),
    });
  } catch (error) {
    log.error('worker_message_send_failed', {
      workerRef: worker.publicRef,
      language,
      caseId: input.caseId ?? null,
      error,
    });
    // null, not '': provider_sid carries a unique index, so repeated failures
    // must not collide with each other.
    sent = { sid: null, status: 'failed' };
  }

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
 * only to address the message. It is never written to the case, the logs or
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
