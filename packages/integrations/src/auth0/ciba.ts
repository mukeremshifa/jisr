import { NotConfiguredError, config, log } from '@jisr/core';

/**
 * Auth0 CIBA (Client-Initiated Backchannel Authentication), F3 step 2.
 *
 * HR approves a pay correction on their phone, out of band from Slack. The
 * `binding_message` is what they see on the lock screen, and
 * `authorization_details` carries the payload hash so the approval is bound to
 * exactly the numbers we computed.
 *
 * https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow
 */

export interface CibaRequestInput {
  /** Identifies the approver to Auth0; format depends on the tenant's config. */
  loginHint: string;
  bindingMessage: string;
  authorizationDetails: Array<Record<string, unknown>>;
  /** Auth0 caps this; push notifications require <= 300s. */
  requestedExpirySeconds?: number;
}

export interface CibaRequest {
  authReqId: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type CibaOutcome =
  | { status: 'approved'; accessToken: string; expiresInSeconds: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'error'; error: string };

function requireCiba(): { domain: string; clientId: string; clientSecret: string } {
  if (!config.AUTH0_DOMAIN || !config.AUTH0_CIBA_CLIENT_ID || !config.AUTH0_CIBA_CLIENT_SECRET) {
    throw new NotConfiguredError('Auth0 CIBA (AUTH0_DOMAIN, AUTH0_CIBA_CLIENT_ID, AUTH0_CIBA_CLIENT_SECRET)');
  }
  return {
    domain: config.AUTH0_DOMAIN,
    clientId: config.AUTH0_CIBA_CLIENT_ID,
    clientSecret: config.AUTH0_CIBA_CLIENT_SECRET,
  };
}

/**
 * Auth0's /bc-authorize only accepts `login_hint` in the `iss_sub` format: the
 * approver's Auth0 user id (e.g. `auth0|abc123`), never an email address.
 */
export function loginHintFor(auth0UserId: string): string {
  const { domain } = requireCiba();
  return JSON.stringify({ format: 'iss_sub', iss: `https://${domain}/`, sub: auth0UserId });
}

export function isCibaConfigured(): boolean {
  return Boolean(config.AUTH0_DOMAIN && config.AUTH0_CIBA_CLIENT_ID && config.AUTH0_CIBA_CLIENT_SECRET);
}

export async function requestApproval(input: CibaRequestInput): Promise<CibaRequest> {
  const { domain, clientId, clientSecret } = requireCiba();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'openid',
    login_hint: input.loginHint,
    binding_message: input.bindingMessage,
    authorization_details: JSON.stringify(input.authorizationDetails),
    // Push notifications require a short expiry; email delivery needs a longer one.
    requested_expiry: String(
      Math.min(input.requestedExpirySeconds ?? (config.AUTH0_CIBA_CHANNEL === 'email' ? 900 : 300), 900),
    ),
    ...(config.AUTH0_CIBA_AUDIENCE ? { audience: config.AUTH0_CIBA_AUDIENCE } : {}),
  });

  const response = await fetch(`https://${domain}/bc-authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`bc-authorize failed (${response.status}): ${String(json.error ?? 'unknown')}`);
  }

  return {
    authReqId: String(json.auth_req_id),
    expiresInSeconds: Number(json.expires_in ?? 300),
    intervalSeconds: Number(json.interval ?? 5),
  };
}

/**
 * Polls the token endpoint until the approver acts. Respects `interval` and backs
 * off on `slow_down`, as the spec requires. Polling faster gets the request
 * rejected, not answered sooner.
 */
export async function pollForApproval(
  request: CibaRequest,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<CibaOutcome> {
  const { domain, clientId, clientSecret } = requireCiba();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  const deadline = now() + request.expiresInSeconds * 1000;
  let intervalMs = Math.max(request.intervalSeconds, 1) * 1000;

  while (now() < deadline) {
    await sleep(intervalMs);

    const body = new URLSearchParams({
      grant_type: 'urn:openid:params:grant-type:ciba',
      auth_req_id: request.authReqId,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json()) as Record<string, unknown>;

    if (response.ok && typeof json.access_token === 'string') {
      return {
        status: 'approved',
        accessToken: json.access_token,
        expiresInSeconds: Number(json.expires_in ?? 0),
      };
    }

    const error = String(json.error ?? 'unknown_error');
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }
    if (error === 'access_denied') return { status: 'denied' };
    if (error === 'expired_token') return { status: 'expired' };

    log.error('ciba_poll_error', { error });
    return { status: 'error', error };
  }

  return { status: 'expired' };
}

/**
 * The `authorization_details` object. The hash is what makes this binding: at
 * execution time we recompute it and refuse to pay if it has moved.
 */
export function payrollAuthorizationDetails(input: {
  casePublicId: string;
  workerPublicRef: string;
  period: string;
  kind: string;
  hoursX100: number;
  amountFils: number;
  payloadSha256: string;
}): Array<Record<string, unknown>> {
  return [
    {
      type: 'payroll_adjustment',
      case_id: input.casePublicId,
      worker_ref: input.workerPublicRef,
      period: input.period,
      kind: input.kind,
      hours: (input.hoursX100 / 100).toFixed(2),
      amount_aed: (input.amountFils / 100).toFixed(2),
      payload_sha256: input.payloadSha256,
    },
  ];
}
