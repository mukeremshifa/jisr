import { describe, expect, it } from 'vitest';
import {
  isPendingAssetValid,
  isValidAssetCode,
  isValidCoordinate,
  matchSite,
  parseStickerCode,
  pendingAssetExpiry,
  stickerUrl,
  type SiteGeo,
} from '@jisr/core';

describe('F1 sticker codes', () => {
  it('parses a pre-filled wa.me message', () => {
    expect(parseStickerCode('JISR-R214')).toBe('R214');
  });

  it('tolerates what WhatsApp actually sends', () => {
    // Lowercase, surrounding whitespace, and a zero-width mark from the client.
    expect(parseStickerCode('  jisr-r214  ')).toBe('R214');
    const zeroWidth = String.fromCodePoint(0x200b);
    const ltrMark = String.fromCodePoint(0x200e);
    expect(parseStickerCode(`${zeroWidth}JISR-GATE-B${ltrMark}`)).toBe('GATE-B');
  });

  it('rejects anything that is not exactly a sticker message', () => {
    expect(parseStickerCode('JISR-R214 the ac is broken')).toBeNull();
    expect(parseStickerCode('the ac in JISR-R214 is broken')).toBeNull();
    expect(parseStickerCode('JISR-')).toBeNull();
    expect(parseStickerCode('JISR-TOOLONGCODE1')).toBeNull();
    expect(parseStickerCode('JISR-R2!4')).toBeNull();
    expect(parseStickerCode(null)).toBeNull();
    expect(parseStickerCode('')).toBeNull();
  });

  it('builds a wa.me URL the QR code can encode', () => {
    expect(stickerUrl('+971 50 123 4567', 'r214')).toBe('https://wa.me/971501234567?text=JISR-R214');
  });

  it('validates asset codes before they are stored', () => {
    expect(isValidAssetCode('R214')).toBe(true);
    expect(isValidAssetCode('GATE-B')).toBe(true);
    expect(isValidAssetCode('R')).toBe(false);
    expect(isValidAssetCode('room 214')).toBe(false);
  });

  it('expires pending asset context after 15 minutes', () => {
    const now = new Date('2026-09-11T10:00:00Z');
    const expires = pendingAssetExpiry(now);
    expect(isPendingAssetValid(expires, new Date('2026-09-11T10:14:59Z'))).toBe(true);
    expect(isPendingAssetValid(expires, new Date('2026-09-11T10:15:01Z'))).toBe(false);
    expect(isPendingAssetValid(null, now)).toBe(false);
  });
});

describe('F1 geofence matching', () => {
  const siteA: SiteGeo = { id: 'a', code: 'A', name: 'Al Quoz yard', lat: 25.1, lng: 55.2, radiusM: 300 };
  const siteB: SiteGeo = { id: 'b', code: 'B', name: 'Camp and site', lat: 25.2, lng: 55.27, radiusM: 300 };
  const noGeo: SiteGeo = { id: 'c', code: 'C', name: 'Unmapped', lat: null, lng: null, radiusM: null };

  it('matches a pin inside a site radius', () => {
    const match = matchSite(25.2001, 55.2701, [siteA, siteB, noGeo]);
    expect(match?.site.code).toBe('B');
    expect(match?.distanceM).toBeLessThan(30);
  });

  it('returns null outside every radius, so we ask instead of guessing', () => {
    expect(matchSite(25.5, 55.9, [siteA, siteB])).toBeNull();
  });

  it('picks the nearest site when radii overlap', () => {
    const wide: SiteGeo = { ...siteA, id: 'wide', code: 'WIDE', radiusM: 50_000 };
    const match = matchSite(25.2001, 55.2701, [wide, siteB]);
    expect(match?.site.code).toBe('B');
  });

  it('ignores sites with no geofence', () => {
    expect(matchSite(25.1, 55.2, [noGeo])).toBeNull();
  });

  it('validates coordinates', () => {
    expect(isValidCoordinate(25.2, 55.27)).toBe(true);
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 0)).toBe(false);
  });
});
