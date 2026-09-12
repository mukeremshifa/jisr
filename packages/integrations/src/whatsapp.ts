import { config } from '@jisr/core';
import { downloadKapsoMedia, isKapsoConfigured, sendWhatsAppKapso } from './kapso';
import { downloadMetaMedia, isMetaConfigured, sendWhatsAppMeta } from './meta';
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
 * Everything above this file — intake, cases, broadcasts, speak-up — sends and
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
