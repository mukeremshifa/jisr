import { config, log, type CaseSeverity } from '@jisr/core';
import { repo, withTenant, type Case, type Site, type Worker } from '@jisr/db';

/** Shared loads and small case helpers used by several tasks. */

export interface CaseContext {
  case: Case;
  site: Site | null;
  worker: Worker | null;
  assetLabel: string | null;
  companyName: string;
}

export async function loadCaseContext(companyId: string, caseId: string): Promise<CaseContext | null> {
  return withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const row = await r.caseById(caseId);
    if (!row) return null;
    const site = row.siteId ? await r.siteById(row.siteId) : null;
    const asset = row.assetId ? await r.assetById(row.assetId) : null;
    const worker = row.workerId ? await r.workerById(row.workerId) : null;
    const company = await r.company();
    return {
      case: row,
      site,
      worker,
      assetLabel: asset?.label ?? null,
      companyName: company?.name ?? config.COMPANY_NAME,
    };
  });
}

/** SLA due time. Minutes in the demo, hours in production, from one env value. */
export function slaDueAt(severity: CaseSeverity, from: Date = new Date()): Date {
  const base = config.DEMO_SLA_MINUTES;
  // Critical cases get a quarter of the window, floored at one minute.
  const minutes = severity === 'critical' ? Math.max(1, Math.floor(base / 4)) : base;
  return new Date(from.getTime() + minutes * 60 * 1000);
}

export function slaTimeoutSpec(severity: CaseSeverity): string {
  const base = config.DEMO_SLA_MINUTES;
  const minutes = severity === 'critical' ? Math.max(1, Math.floor(base / 4)) : base;
  return `${minutes}m`;
}

export function dashboardCaseUrl(publicId: string): string | null {
  if (!config.PUBLIC_DASHBOARD_URL) return null;
  return `${config.PUBLIC_DASHBOARD_URL.replace(/\/+$/, '')}/cases/${publicId}`;
}

export function logCase(event: string, ctx: CaseContext, extra: Record<string, unknown> = {}): void {
  log.info(event, {
    casePublicId: ctx.case.publicId,
    status: ctx.case.status,
    category: ctx.case.category,
    severity: ctx.case.severity,
    isSpeakup: ctx.case.isSpeakup,
    ...extra,
  });
}
