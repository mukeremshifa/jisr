import { config } from '@jisr/core';

/**
 * The exact URL Twilio signed.
 *
 * Twilio computes its signature over the full public URL it called. Behind Cloud
 * Run the request's own Host is the internal one, and trusting `X-Forwarded-Host`
 * would let an attacker choose the string we validate against. So we build the
 * URL from PUBLIC_GATEWAY_URL - a value we control - plus the path and query.
 */
export function publicUrlFor(path: string, search: string): string {
  const base = (config.PUBLIC_GATEWAY_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('PUBLIC_GATEWAY_URL must be set to validate webhook signatures');
  return `${base}${path}${search}`;
}
