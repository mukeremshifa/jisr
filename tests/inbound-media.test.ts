import { describe, expect, it } from 'vitest';
import { MediaRejected, estimateAudioSeconds, prepareMedia } from '@jisr/integrations';

/**
 * The inbound half of voice. A worker's voice note reaches prepareMedia as raw
 * bytes plus whatever content type the carrier declared, and both have to survive
 * the allowlist for the note to ever be transcribed.
 */

/**
 * The opening pages of an OGG stream, which is all the sniffer reads. WhatsApp
 * voice notes are Opus in an OGG container; the codec is what makes file-type
 * report a parameterised `audio/ogg; codecs=opus`.
 */
function oggHeader(codec: 'opus' | 'vorbis'): Buffer {
  const buffer = Buffer.alloc(96);
  buffer.write('OggS', 0, 'ascii');
  buffer.writeUInt8(0, 4); // stream structure version
  buffer.writeUInt8(2, 5); // first page of the logical bitstream
  buffer.writeUInt8(1, 26); // one segment in the table
  if (codec === 'opus') {
    buffer.writeUInt8(19, 27);
    buffer.write('OpusHead', 28, 'ascii');
  } else {
    buffer.writeUInt8(30, 27);
    buffer.writeUInt8(1, 28);
    buffer.write('vorbis', 29, 'ascii');
  }
  return buffer;
}

describe('inbound voice notes survive the allowlist', () => {
  // The bug this covers: file-type reports Opus as `audio/ogg; codecs=opus`,
  // which matched no allowlist entry, so every voice note was answered with
  // "I can read photos and voice notes only".
  it('accepts an Opus voice note despite the codec parameter', async () => {
    const prepared = await prepareMedia({
      bytes: oggHeader('opus'),
      declaredContentType: 'audio/ogg; codecs=opus',
    });
    expect(prepared.kind).toBe('audio_in');
    expect(prepared.contentType).toBe('audio/ogg');
  });

  it('accepts a plain OGG voice note', async () => {
    const prepared = await prepareMedia({
      bytes: oggHeader('vorbis'),
      declaredContentType: 'audio/ogg',
    });
    expect(prepared.kind).toBe('audio_in');
    expect(prepared.contentType).toBe('audio/ogg');
  });

  it('ignores parameters and casing on the carrier-declared type', async () => {
    const prepared = await prepareMedia({
      bytes: oggHeader('opus'),
      declaredContentType: 'AUDIO/OGG; CODECS=OPUS',
    });
    expect(prepared.contentType).toBe('audio/ogg');
  });

  // The allowlist still has to hold: a renamed executable is not a voice note.
  it('rejects bytes that are not media at all', async () => {
    await expect(
      prepareMedia({ bytes: Buffer.from('MZ\x90\x00not audio'), declaredContentType: 'audio/ogg' }),
    ).rejects.toBeInstanceOf(MediaRejected);
  });

  it('passes the audio through unmodified, so the transcript matches what was said', async () => {
    const bytes = oggHeader('opus');
    const prepared = await prepareMedia({ bytes, declaredContentType: 'audio/ogg; codecs=opus' });
    expect(prepared.bytes.equals(bytes)).toBe(true);
  });
});

describe('audio duration estimate', () => {
  it('over-counts rather than under-counts, so the budget is never overspent', () => {
    // 32 kbps assumed: 8 KB is two seconds, and AMR is charged at its lower rate.
    expect(estimateAudioSeconds(8_000, 'audio/ogg')).toBe(2);
    expect(estimateAudioSeconds(8_000, 'audio/amr')).toBeGreaterThan(2);
  });
});
