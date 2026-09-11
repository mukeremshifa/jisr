import 'server-only';
import { OPEN_STATUSES, languageOf, type CaseCategory, type CaseStatus } from '@jisr/core';
import { repo, withTenant } from '@jisr/db';
import { signedUrl } from '@jisr/integrations';
import { canViewCase, requireActor, visibleSiteIds } from './actor';
import { toCaseListItem, toPayRow, type CaseListItem, type PayRow, type TimelineItem } from './dto';

/**
 * Every read the dashboard makes.
 *
 * Two rules hold throughout: the company and the sites come from the session,
 * and every record fetched by id is FGA-checked before it is returned. That is
 * what stops an insecure direct object reference — the public ids are random,
 * but randomness is not authorization.
 */

export interface CaseFilters {
  siteId?: string;
  status?: CaseStatus;
  category?: CaseCategory;
  openOnly?: boolean;
  includeSpeakup?: boolean;
  limit?: number;
}

export async function listCases(filters: CaseFilters = {}): Promise<CaseListItem[]> {
  const actor = await requireActor();
  const allowed = await visibleSiteIds();

  // A filter may narrow what the actor can see; it can never widen it.
  const siteIds = filters.siteId ? allowed.filter((id) => id === filters.siteId) : allowed;

  // Speak-up reports are a separate query with a separate relation.
  const canSeeSpeakup = actor.roles.hr || actor.roles.compliance;

  const rows = await withTenant(actor.companyId, async ({ tx }) => {
    const r = repo(actor.companyId, tx);
    const normal =
      siteIds.length > 0
        ? await r.openCases({
            siteIds,
            ...(filters.status ? { statuses: [filters.status] } : {}),
            ...(filters.openOnly ? { statuses: [...OPEN_STATUSES] } : {}),
            ...(filters.category ? { category: filters.category } : {}),
            limit: filters.limit ?? 50,
          })
        : [];

    const speakup =
      canSeeSpeakup && filters.includeSpeakup !== false
        ? (await r.openCases({ includeSpeakup: true, limit: 50 })).filter((row) => row.isSpeakup)
        : [];

    const combined = [...normal, ...speakup].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );

    const items: CaseListItem[] = [];
    for (const row of combined.slice(0, filters.limit ?? 50)) {
      const site = row.siteId ? await r.siteById(row.siteId) : null;
      const asset = row.assetId ? await r.assetById(row.assetId) : null;
      const worker = row.workerId ? await r.workerById(row.workerId) : null;
      items.push(
        toCaseListItem(row, {
          siteName: site?.name ?? null,
          assetLabel: asset?.label ?? null,
          workerRef: worker?.publicRef ?? null,
        }),
      );
    }
    return items;
  });

  return rows;
}

export interface CaseDetail {
  header: CaseListItem;
  transcriptOriginal: string | null;
  rtl: boolean;
  timeline: TimelineItem[];
  canAct: boolean;
}

/** Returns null for "not found or not allowed" — the two must look identical. */
export async function getCase(publicId: string): Promise<CaseDetail | null> {
  const actor = await requireActor();

  const row = await withTenant(actor.companyId, ({ tx }) =>
    repo(actor.companyId, tx).caseByPublicId(publicId),
  );
  if (!row) return null;

  if (!(await canViewCase(row.id, row.isSpeakup))) return null;

  const { canActOnCase } = await import('./actor');
  const canAct = row.isSpeakup ? false : await canActOnCase(row.id);

  return withTenant(actor.companyId, async ({ tx }) => {
    const r = repo(actor.companyId, tx);
    const site = row.siteId ? await r.siteById(row.siteId) : null;
    const asset = row.assetId ? await r.assetById(row.assetId) : null;
    const worker = row.workerId ? await r.workerById(row.workerId) : null;

    const messages = await r.messagesForCase(row.id);
    const events = await r.caseTimeline(row.id);
    const entry = languageOf(row.language);

    const timeline: TimelineItem[] = [];

    for (const message of messages) {
      let mediaUrl: string | null = null;
      let mediaKind: TimelineItem['mediaKind'] = null;
      if (message.mediaId) {
        const item = await r.mediaById(message.mediaId);
        if (item) {
          mediaKind = item.kind;
          // A speak-up case never exposes the reporter's own voice, only the
          // synthetic re-voicing of the redacted summary.
          const allowed = !row.isSpeakup || item.kind === 'audio_out';
          if (allowed) mediaUrl = await signedUrl(item.gcsKey, 'dashboard').catch(() => null);
        }
      }

      timeline.push({
        id: message.id,
        kind: 'message',
        direction: message.direction,
        textOriginal: message.textOriginal,
        textEn: message.textEn,
        language: message.language,
        rtl: languageOf(message.language ?? row.language).rtl,
        mediaUrl,
        mediaKind,
        label: null,
        at: message.createdAt.toISOString(),
      });
    }

    for (const event of events) {
      timeline.push({
        id: event.id,
        kind: 'event',
        direction: null,
        textOriginal: null,
        textEn: null,
        language: null,
        rtl: false,
        mediaUrl: null,
        mediaKind: null,
        label: event.type.replace(/[:_]/g, ' '),
        at: event.createdAt.toISOString(),
      });
    }

    timeline.sort((a, b) => a.at.localeCompare(b.at));

    return {
      header: toCaseListItem(row, {
        siteName: site?.name ?? null,
        assetLabel: asset?.label ?? null,
        workerRef: worker?.publicRef ?? null,
      }),
      transcriptOriginal: row.transcriptOriginal,
      rtl: entry.rtl,
      timeline,
      canAct,
    };
  });
}

export interface Overview {
  openBySite: Array<{ siteName: string; open: number; pastSla: number }>;
  openByCategory: Array<{ category: string; count: number }>;
  pastSla: CaseListItem[];
  medianFirstResponseMinutes: number | null;
  broadcastAckRate: { acked: number; total: number } | null;
  needsActionNow: CaseListItem[];
}

export async function getOverview(): Promise<Overview> {
  const actor = await requireActor();
  const siteIds = await visibleSiteIds();
  const cases = await listCases({ openOnly: true, limit: 200 });

  const bySite = new Map<string, { open: number; pastSla: number }>();
  const byCategory = new Map<string, number>();
  for (const item of cases) {
    const key = item.siteName ?? 'Speak-up';
    const entry = bySite.get(key) ?? { open: 0, pastSla: 0 };
    entry.open += 1;
    if (item.pastSla) entry.pastSla += 1;
    bySite.set(key, entry);
    byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);
  }

  const stats = await withTenant(actor.companyId, async ({ tx }) => {
    const r = repo(actor.companyId, tx);

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const today = (await r.openCases({ siteIds, limit: 200 })).filter(
      (row) => row.firstResponseAt && row.createdAt >= startOfDay,
    );
    const durations = today
      .map((row) => (row.firstResponseAt!.getTime() - row.createdAt.getTime()) / 60_000)
      .sort((a, b) => a - b);
    const median =
      durations.length === 0
        ? null
        : Math.round(
            durations.length % 2 === 1
              ? durations[(durations.length - 1) / 2]!
              : (durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2,
          );

    return { median };
  });

  const latest = (await listBroadcasts(1))[0];

  return {
    openBySite: [...bySite.entries()]
      .map(([siteName, v]) => ({ siteName, ...v }))
      .sort((a, b) => b.open - a.open),
    openByCategory: [...byCategory.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    pastSla: cases.filter((c) => c.pastSla),
    medianFirstResponseMinutes: stats.median,
    broadcastAckRate: latest ? { acked: latest.acked, total: latest.total } : null,
    needsActionNow: cases
      .filter((c) => c.pastSla || c.severity === 'critical' || c.needsReview)
      .slice(0, 10),
  };
}

export interface BroadcastRow {
  id: string;
  publicId: string;
  textEn: string;
  status: string;
  createdAt: string;
  total: number;
  acked: number;
  pending: string[];
}

export async function listBroadcasts(limit = 20): Promise<BroadcastRow[]> {
  const actor = await requireActor();
  const allowed = new Set(await visibleSiteIds());

  return withTenant(actor.companyId, async ({ tx }) => {
    const r = repo(actor.companyId, tx);
    const rows = await r.recentBroadcasts(limit);

    const out: BroadcastRow[] = [];
    for (const broadcast of rows) {
      // A supervisor sees broadcasts that touched one of their own sites.
      const targeted = broadcast.target.siteIds;
      if (targeted.length > 0 && !targeted.some((id) => allowed.has(id))) continue;

      const deliveries = await r.deliveries(broadcast.id);
      const pending: string[] = [];
      for (const delivery of deliveries) {
        if (delivery.ackedAt) continue;
        const worker = await r.workerById(delivery.workerId);
        if (worker) pending.push(worker.publicRef);
      }

      out.push({
        id: broadcast.id,
        publicId: broadcast.publicId,
        textEn: broadcast.textEn,
        status: broadcast.status,
        createdAt: broadcast.createdAt.toISOString(),
        total: deliveries.length,
        acked: deliveries.filter((d) => d.ackedAt).length,
        pending,
      });
    }
    return out;
  });
}

export async function listPayApprovals(limit = 50): Promise<PayRow[]> {
  const actor = await requireActor();
  // The pay queue is company-wide and read-only here: the dashboard can show
  // approvals but can never approve one.
  if (!actor.roles.hr && !actor.roles.opsAdmin) return [];

  return withTenant(actor.companyId, async ({ tx }) => {
    const r = repo(actor.companyId, tx);
    const rows = await r.payQueue(limit);
    const out: PayRow[] = [];
    for (const row of rows) {
      const caseRow = await r.caseById(row.caseId);
      const worker = await r.workerById(row.workerId);
      const proposed = row.proposedByStaffId ? await r.staffById(row.proposedByStaffId) : null;
      const approved = row.approvedByStaffId ? await r.staffById(row.approvedByStaffId) : null;
      out.push(
        toPayRow(row, {
          casePublicId: caseRow?.publicId ?? '—',
          workerRef: worker?.publicRef ?? '—',
          proposedBy: proposed?.displayName ?? null,
          approvedBy: approved?.displayName ?? null,
        }),
      );
    }
    return out;
  });
}

export interface AuditRow {
  id: string;
  event: string;
  severity: string;
  actor: string | null;
  subject: string | null;
  at: string;
}

export async function listAudit(limit = 100): Promise<AuditRow[]> {
  const actor = await requireActor();
  if (!actor.roles.hr && !actor.roles.opsAdmin) return [];

  const rows = await withTenant(actor.companyId, ({ tx }) =>
    repo(actor.companyId, tx).auditEntries(limit),
  );
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    severity: row.severity,
    actor: row.actor,
    subject: row.subject,
    at: row.createdAt.toISOString(),
  }));
}

export interface AssetRow {
  id: string;
  code: string;
  label: string;
  kind: string;
  siteName: string | null;
  active: boolean;
}

export async function listAssets(): Promise<AssetRow[]> {
  const actor = await requireActor();
  if (!actor.roles.opsAdmin) return [];

  return withTenant(actor.companyId, async ({ tx }) => {
    const r = repo(actor.companyId, tx);
    const assets = await r.allAssets();
    const out: AssetRow[] = [];
    for (const asset of assets) {
      const site = asset.siteId ? await r.siteById(asset.siteId) : null;
      out.push({
        id: asset.id,
        code: asset.code,
        label: asset.label,
        kind: asset.kind,
        siteName: site?.name ?? null,
        active: asset.active,
      });
    }
    return out;
  });
}

export async function listSites(): Promise<Array<{ id: string; code: string; name: string }>> {
  const actor = await requireActor();
  const allowed = new Set(await visibleSiteIds());
  const sites = await withTenant(actor.companyId, ({ tx }) => repo(actor.companyId, tx).sites());
  return sites.filter((s) => allowed.has(s.id)).map((s) => ({ id: s.id, code: s.code, name: s.name }));
}
