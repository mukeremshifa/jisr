'use server';

import { tasks } from '@trigger.dev/sdk';
import { sanitizeText } from '@jisr/core';
import { requireActor, visibleSiteIds } from '@/lib/actor';

/**
 * Drafting a broadcast is the only write the dashboard makes, and it is not a
 * send: it asks the agent for a translation preview, which lands in Slack behind
 * a Send button.
 *
 * Server Actions carry Next's origin check; the sites are intersected with what
 * FGA allows rather than trusted from the form.
 */
export async function composeBroadcast(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const actor = await requireActor();

  const text = sanitizeText(String(formData.get('text') ?? ''), 600);
  if (!text) return { ok: false, message: 'Write something first.' };

  const requested = formData.getAll('siteIds').map(String);
  const allowed = new Set(await visibleSiteIds());
  const siteIds = requested.filter((id) => allowed.has(id));

  if (siteIds.length === 0) {
    return { ok: false, message: 'Pick at least one site you are allowed to broadcast to.' };
  }

  try {
    await tasks.trigger('broadcast.compose', {
      source: 'dashboard',
      slackChannelId: '',
      slackUserId: '',
      textEn: text,
      companyId: actor.companyId,
      staffId: actor.staff.id,
      siteIds,
    } as never);
  } catch {
    return { ok: false, message: 'I could not reach the agent. Nothing was sent.' };
  }

  return {
    ok: true,
    message: 'Translating now. The preview will appear in Slack — press Send there when it looks right.',
  };
}
