import { Storage } from '@google-cloud/storage';
import { NotConfiguredError, config, log, newMediaKey } from '@jisr/core';

/**
 * Private Google Cloud Storage. Uniform bucket-level access with public access
 * prevention enforced (set on the bucket, not here). Nothing is ever public:
 * readers get a V4 signed URL that expires.
 *
 * Signing works without a key file when the Cloud Run service account has the
 * Service Account Token Creator role on itself — see docs/security.md.
 */

const DASHBOARD_URL_TTL_MS = 10 * 60 * 1000;
const TWILIO_URL_TTL_MS = 60 * 60 * 1000;

let storage: Storage | undefined;

function getStorage(): Storage {
  if (storage) return storage;
  if (!config.GCS_BUCKET) throw new NotConfiguredError('GCS_BUCKET');
  storage = new Storage(config.GOOGLE_CLOUD_PROJECT ? { projectId: config.GOOGLE_CLOUD_PROJECT } : {});
  return storage;
}

export function isGcsConfigured(): boolean {
  return Boolean(config.GCS_BUCKET);
}

export interface UploadInput {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

export async function uploadMedia(input: UploadInput): Promise<{ gcsKey: string }> {
  const key = newMediaKey(input.extension);
  const file = getStorage().bucket(config.GCS_BUCKET!).file(key);
  await file.save(input.bytes, {
    contentType: input.contentType,
    resumable: false,
    metadata: {
      contentType: input.contentType,
      cacheControl: 'private, max-age=0, no-store',
    },
  });
  log.info('media_uploaded', { gcsKey: key, bytes: input.bytes.byteLength, contentType: input.contentType });
  return { gcsKey: key };
}

export type SignedUrlAudience = 'dashboard' | 'twilio';

export async function signedUrl(gcsKey: string, audience: SignedUrlAudience): Promise<string> {
  const ttl = audience === 'twilio' ? TWILIO_URL_TTL_MS : DASHBOARD_URL_TTL_MS;
  const [url] = await getStorage()
    .bucket(config.GCS_BUCKET!)
    .file(gcsKey)
    .getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + ttl });
  return url;
}

export async function downloadMedia(gcsKey: string): Promise<Buffer> {
  const [buffer] = await getStorage().bucket(config.GCS_BUCKET!).file(gcsKey).download();
  return buffer;
}
