import type { Context, MiddlewareHandler, Next } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { log } from '@jisr/core';

/**
 * The gateway is server-to-server only: Twilio and Slack post to it, nothing else.
 * So it sends *no* CORS headers, serves no static files, and returns a bare 404
 * for anything it does not recognise.
 */

export const securityHeaders: MiddlewareHandler = secureHeaders({
  strictTransportSecurity: 'max-age=63072000; includeSubDomains',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  xFrameOptions: 'DENY',
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
  },
  permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  crossOriginResourcePolicy: 'same-origin',
});

/**
 * Body-size cap. Read before parsing, so an oversized body is refused rather than
 * buffered. Webhooks get 64 KB; nothing legitimate comes close.
 */
export function bodyLimit(maxBytes: number): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      log.warn('body_too_large', { declared, maxBytes, path: c.req.path });
      return c.text('', 413);
    }
    await next();
  };
}

/** Request logging without leaking bodies, tokens or phone numbers. */
export const requestLog: MiddlewareHandler = async (c, next) => {
  const started = Date.now();
  await next();
  log.info('http_request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - started,
  });
};
