import { NotConfiguredError, config } from '@jisr/core';
import { downloadKapsoMedia, isKapsoConfigured, sendWhatsAppKapso, uploadKapsoMedia } from './kapso';
import { downloadMetaMedia, isMetaConfigured, sendWhatsAppMeta, uploadMetaMedia } from './meta';
import {
  downloadTwilioMedia,
  isTwilioConfigured,
  sendWhatsApp as sendWhatsAppTwilio,
  type DownloadedMedia,
  type SendResult,
  type SendWhatsAppInput,
} from './twilio';

/**
 * The WhatsApp carrier, chosen by `WHATSAPP_PROVIDER`.
 *
 * Everything above this file, intake, cases, broadcasts and speak-up, send and
 * fetches media through here and never learns which carrier answered.
 */

export type WhatsAppProvider = 'twilio' | 'meta' | 'kapso';

export function whatsAppProvider(): WhatsAppProvider {
  return config.WHATSAPP_PROVIDER;
}

export function isWhatsAppConfigured(): boolean {
  switch (whatsAppProvider()) {
    case 'meta':
      return isMetaConfigured();
    case 'kapso':
      return isKapsoConfigured();
    default:
      return isTwilioConfigured();
  }
}

export async function sendWhatsAppMessage(input: SendWhatsAppInput): Promise<SendResult> {
  switch (whatsAppProvider()) {
    case 'meta':
      return sendWhatsAppMeta(input);
    case 'kapso':
      return sendWhatsAppKapso(input);
    default:
      return sendWhatsAppTwilio(input);
  }
}

/**
 * True when the active carrier can host outbound media itself.
 *
 * Twilio cannot: it only fetches a URL we host, so it still needs object
 * storage for voice notes.
 */
export function supportsMediaUpload(): boolean {
  const provider = whatsAppProvider();
  return provider === 'meta' || provider === 'kapso';
}

/**
 * Uploads outbound audio to the carrier and returns its media id.
 *
 * Sending by id is what makes WhatsApp render a voice note rather than a plain
 * audio file, and it removes the need for a public URL, so a voice note works
 * with no object storage configured at all.
 */
export async function uploadWhatsAppMedia(input: {
  bytes: Buffer;
  contentType: string;
  filename: string;
}): Promise<string> {
  switch (whatsAppProvider()) {
    case 'meta':
      return uploadMetaMedia(input);
    case 'kapso':
      return uploadKapsoMedia(input);
    default:
      throw new NotConfiguredError('outbound media upload (Twilio has no media endpoint)');
  }
}

/**
 * Fetches one inbound media item. The reference is whatever the active carrier
 * put on the message: a Meta media id, a Kapso media URL, or a Twilio media URL.
 */
export async function downloadWhatsAppMedia(ref: string, maxBytes: number): Promise<DownloadedMedia> {
  switch (whatsAppProvider()) {
    case 'meta':
      return downloadMetaMedia(ref, maxBytes);
    case 'kapso':
      return downloadKapsoMedia(ref, maxBytes);
    default:
      return downloadTwilioMedia(ref, maxBytes);
  }
}
