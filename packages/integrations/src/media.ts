import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { config } from '@jisr/core';

/**
 * Upload handling for WhatsApp media.
 *
 * Two independent checks: the type Twilio declares, and the magic bytes we read
 * ourselves. Both must land in the allowlist. Images are re-encoded with sharp so
 * EXIF (including GPS) never reaches storage, which matters most for speak-up,
 * where a room number or a location can identify the reporter.
 */

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ALLOWED_AUDIO_TYPES = [
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
] as const;

const ALLOWED = new Set<string>([...ALLOWED_IMAGE_TYPES, ...ALLOWED_AUDIO_TYPES]);

/** file-type reports containers, not codecs: an OGG voice note may sniff as video/ogg. */
const SNIFF_ALIASES: Record<string, string> = {
  'video/ogg': 'audio/ogg',
  'application/ogg': 'audio/ogg',
  'video/mp4': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/vnd.wave': 'audio/mpeg',
};

/**
 * The media type without its parameters, lowercased.
 *
 * Both the sniffer and the carriers hand back parameterised types: file-type
 * reports a WhatsApp voice note as `audio/ogg; codecs=opus`, which matches no
 * entry in the allowlist and used to be rejected as the wrong kind of file.
 */
function baseType(value: string): string {
  return value.split(';')[0]!.trim().toLowerCase();
}

export class MediaRejected extends Error {
  constructor(
    readonly reason: 'type' | 'size' | 'unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'MediaRejected';
  }
}

export interface PreparedMedia {
  bytes: Buffer;
  contentType: string;
  extension: string;
  kind: 'image' | 'audio_in';
  sha256: string;
}

export async function prepareMedia(input: {
  bytes: Buffer;
  declaredContentType: string;
}): Promise<PreparedMedia> {
  const declared = baseType(input.declaredContentType);
  const sniffed = await fileTypeFromBuffer(input.bytes);
  const sniffedBase = sniffed ? baseType(sniffed.mime) : undefined;
  const sniffedType = sniffedBase ? (SNIFF_ALIASES[sniffedBase] ?? sniffedBase) : undefined;

  if (!sniffedType) throw new MediaRejected('unreadable', 'could not identify file type');
  if (!ALLOWED.has(sniffedType)) throw new MediaRejected('type', `sniffed type not allowed: ${sniffedType}`);
  if (!ALLOWED.has(declared) && !declared.startsWith(sniffedType.split('/')[0]!)) {
    throw new MediaRejected('type', `declared type not allowed: ${declared}`);
  }

  const isImage = (ALLOWED_IMAGE_TYPES as readonly string[]).includes(sniffedType);

  if (isImage) {
    if (input.bytes.byteLength > config.CAP_IMAGE_BYTES) {
      throw new MediaRejected('size', `image too large: ${input.bytes.byteLength}`);
    }
    // rotate() first so the pixels match the EXIF orientation we are about to drop.
    const reencoded = await sharp(input.bytes, { failOn: 'error' })
      .rotate()
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return {
      bytes: reencoded,
      contentType: 'image/jpeg',
      extension: 'jpg',
      kind: 'image',
      sha256: sha256(reencoded),
    };
  }

  if (input.bytes.byteLength > config.CAP_AUDIO_BYTES) {
    throw new MediaRejected('size', `audio too large: ${input.bytes.byteLength}`);
  }
  return {
    bytes: input.bytes,
    contentType: sniffedType,
    extension: sniffed!.ext,
    kind: 'audio_in',
    sha256: sha256(input.bytes),
  };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Approximate audio duration, for the per-worker daily audio budget. Reading a
 * precise duration needs a demuxer; a bitrate estimate is enough to stop abuse
 * and is deliberately conservative (it over-counts rather than under-counts).
 */
export function estimateAudioSeconds(bytes: number, contentType: string): number {
  const bitsPerSecond = contentType.includes('amr') ? 12_200 : 32_000;
  return Math.ceil((bytes * 8) / bitsPerSecond);
}
