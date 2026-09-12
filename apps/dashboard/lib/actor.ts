import { cache } from 'react';
import { ForbiddenError, config } from '@jisr/core';
import { repo, withTenant, type Staff } from '@jisr/db';
import { fga } from '@jisr/integrations';
import { auth0 } from './auth0';

/**
 * Who is asking, derived from the session and nothing else.
 *
 * The company, the sites and the permissions all come from the server side. A
 * client may send a company id, a site id or a role; none of it is read.
 */

export interface Actor {
  staff: Staff;
  companyId: string;
  /** FGA subject, e.g. `user:<staff uuid>`. */
  ref: string;
  roles: {
    hr: boolean;
    compliance: boolean;
    opsAdmin: boolean;
  };
}

/** Cached per request, so one page render resolves the actor once. */
export const getActor = cache(async (): Promise<Actor | null> => {
  const session = await auth0.getSession();
  const sub = session?.user?.sub;
  if (!sub) return null;

  const companyId = config.DEFAULT_COMPANY_ID;
  if (!companyId) return null;

  const staff = await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const bySub = await r.staffByAuth0Sub(sub);
    if (bySub) return bySub;

    // First login: the roster row exists with an email but no Auth0 subject yet.
    const email = typeof session?.user?.email === 'string' ? session.user.email : null;
    if (!email) return null;
    const all = await r.allStaff();
    const match = all.find((row) => row.email.toLowerCase() === email.toLowerCase()) ?? null;
    // Link the Auth0 subject so later sign-ins match by sub, and so CIBA can
    // address this person's phone (Auth0 needs the user id, not the email).
    if (match && !match.auth0Sub) await r.linkStaffAuth0Sub(match.id, sub);
    return match;
  });

  if (!staff) return null;

  const ref = fga.userRef(staff.id);
  const [hr, compliance, opsAdmin] = await Promise.all([
    fga.check({ user: ref, relation: 'hr', object: fga.companyRef(companyId) }),
    fga.check({ user: ref, relation: 'compliance', object: fga.companyRef(companyId) }),
    fga.check({ user: ref, relation: 'ops_admin', object: fga.companyRef(companyId) }),
  ]);

  return { staff, companyId, ref, roles: { hr, compliance, opsAdmin } };
});

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError('not signed in');
  return actor;
}

/** Sites this actor may see. Used to scope every list, never a client-sent filter. */
export const visibleSiteIds = cache(async (): Promise<string[]> => {
  const actor = await requireActor();
  const sites = await withTenant(actor.companyId, ({ tx }) => repo(actor.companyId, tx).sites());
  return fga.allowedSiteIds(actor.ref, sites.map((s) => s.id));
});

/** A speak-up case is gated by can_view_speakup, never by can_view. */
export async function canViewCase(caseId: string, isSpeakup: boolean): Promise<boolean> {
  const actor = await requireActor();
  return fga.check({
    user: actor.ref,
    relation: isSpeakup ? 'can_view_speakup' : 'can_view',
    object: fga.caseRef(caseId),
  });
}

export async function canActOnCase(caseId: string): Promise<boolean> {
  const actor = await requireActor();
  return fga.check({ user: actor.ref, relation: 'can_act', object: fga.caseRef(caseId) });
}
