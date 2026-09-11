import { CredentialsMethod, OpenFgaClient } from '@openfga/sdk';
import { ForbiddenError, config, log } from '@jisr/core';

/**
 * Auth0 FGA. Every authorization decision in Jisr goes through `check()`.
 *
 * Deny by default: a missing store, a network error, or an unknown relation all
 * return false. A check that cannot be answered is a check that failed.
 *
 * Model and seed tuples live in `fga/`.
 */

export type Relation =
  | 'hr'
  | 'compliance'
  | 'ops_admin'
  | 'supervisor'
  | 'manager'
  | 'can_view_cases'
  | 'can_act_on_cases'
  | 'can_view'
  | 'can_act'
  | 'can_view_speakup'
  | 'can_approve_pay';

export interface CheckInput {
  /** Auth0 subject or a staff id, formatted `user:<id>`. */
  user: string;
  relation: Relation;
  /** `case:<uuid>`, `site:<uuid>`, `company:<uuid>` */
  object: string;
}

let client: OpenFgaClient | undefined;

export function isFgaConfigured(): boolean {
  return Boolean(config.FGA_API_URL && config.FGA_STORE_ID);
}

function getClient(): OpenFgaClient {
  if (client) return client;
  client = new OpenFgaClient({
    apiUrl: config.FGA_API_URL!,
    storeId: config.FGA_STORE_ID!,
    ...(config.FGA_MODEL_ID ? { authorizationModelId: config.FGA_MODEL_ID } : {}),
    ...(config.FGA_CLIENT_ID && config.FGA_CLIENT_SECRET
      ? {
          credentials: {
            method: CredentialsMethod.ClientCredentials,
            config: {
              clientId: config.FGA_CLIENT_ID,
              clientSecret: config.FGA_CLIENT_SECRET,
              apiTokenIssuer: config.FGA_API_TOKEN_ISSUER ?? 'auth.fga.dev',
              apiAudience: config.FGA_API_AUDIENCE ?? 'https://api.us1.fga.dev/',
            },
          },
        }
      : {}),
  });
  return client;
}

export async function check(input: CheckInput): Promise<boolean> {
  if (!isFgaConfigured()) {
    // Fail closed, loudly. A demo without FGA must show denials, not fake grants.
    log.warn('fga_not_configured_denying', { relation: input.relation, object: input.object });
    return false;
  }
  try {
    const result = await getClient().check({
      user: input.user,
      relation: input.relation,
      object: input.object,
    });
    const allowed = result.allowed === true;
    if (!allowed) log.info('fga_denied', { user: input.user, relation: input.relation, object: input.object });
    return allowed;
  } catch (error) {
    log.error('fga_check_failed', { relation: input.relation, object: input.object, error });
    return false;
  }
}

/** Throwing variant for route handlers and copilot tools. */
export async function assertCan(input: CheckInput): Promise<void> {
  if (!(await check(input))) {
    throw new ForbiddenError('not allowed', { relation: input.relation, object: input.object });
  }
}

/** Batch form for list endpoints: filter a page of records down to what the user may see. */
export async function filterAllowed<T>(
  user: string,
  relation: Relation,
  items: T[],
  objectOf: (item: T) => string,
): Promise<T[]> {
  if (items.length === 0) return [];
  if (!isFgaConfigured()) return [];
  const results = await Promise.all(items.map((item) => check({ user, relation, object: objectOf(item) })));
  return items.filter((_, index) => results[index]);
}

/** Which sites a supervisor may act on, used to scope broadcasts and dashboards. */
export async function allowedSiteIds(user: string, siteIds: string[]): Promise<string[]> {
  const allowed = await filterAllowed(user, 'can_view_cases', siteIds, (id) => `site:${id}`);
  return allowed;
}

export function userRef(staffIdOrSub: string): string {
  return `user:${staffIdOrSub}`;
}

export function caseRef(caseId: string): string {
  return `case:${caseId}`;
}

export function siteRef(siteId: string): string {
  return `site:${siteId}`;
}

export function companyRef(companyId: string): string {
  return `company:${companyId}`;
}

/** Writes the tuples a new case needs so checks resolve through site and company. */
export async function writeCaseTuples(input: {
  caseId: string;
  siteId: string | null;
  companyId: string;
}): Promise<void> {
  if (!isFgaConfigured()) return;
  const tuples = [
    { user: companyRef(input.companyId), relation: 'company', object: caseRef(input.caseId) },
    ...(input.siteId
      ? [{ user: siteRef(input.siteId), relation: 'site', object: caseRef(input.caseId) }]
      : []),
  ];
  try {
    await getClient().write({ writes: tuples });
  } catch (error) {
    // Duplicate tuples are expected on retries and are not an error.
    log.warn('fga_write_case_tuples_failed', { caseId: input.caseId, error });
  }
}
