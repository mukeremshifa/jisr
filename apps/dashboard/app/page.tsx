import { getActor } from '@/lib/actor';
import { getOverview } from '@/lib/data';
import { CaseTable } from '@/components/case-table';
import { SiteSummary } from '@/components/site-summary';
import { Empty, SectionTitle, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** Overview: what is open, what is late, and what needs a person right now. */
export default async function OverviewPage() {
  const actor = await getActor();
  if (!actor) return <Empty>Sign in to see cases.</Empty>;

  const overview = await getOverview();
  const totalOpen = overview.openBySite.reduce((sum, row) => sum + row.open, 0);
  const totalLate = overview.pastSla.length;

  return (
    <div className="flex flex-col gap-[48px]">
      <section>
        <div className="grid grid-cols-2 gap-[16px] md:grid-cols-4">
          <Stat label="Open cases" value={totalOpen} />
          <Stat label="Past SLA" value={totalLate} act={totalLate > 0} hint="no first response yet" />
          <Stat
            label="Median first response"
            value={overview.medianFirstResponseMinutes === null ? '–' : `${overview.medianFirstResponseMinutes}m`}
            hint="today"
          />
          <Stat
            label="Broadcast heard"
            value={
              overview.broadcastAckRate
                ? `${overview.broadcastAckRate.acked}/${overview.broadcastAckRate.total}`
                : '–'
            }
            hint="most recent"
          />
        </div>
      </section>

      <section>
        <SectionTitle>Needs action now</SectionTitle>
        <CaseTable cases={overview.needsActionNow} />
      </section>

      <section>
        <SectionTitle>Open by site</SectionTitle>
        <SiteSummary rows={overview.openBySite} />
      </section>

      <section>
        <SectionTitle>Open by category</SectionTitle>
        {overview.openByCategory.length === 0 ? (
          <Empty>Nothing open.</Empty>
        ) : (
          <div className="card divide-y divide-[--color-rule]">
            {overview.openByCategory.map((row) => (
              <div key={row.category} className="flex items-center justify-between p-[16px]">
                <span className="text-[14px] capitalize">{row.category}</span>
                <span className="text-[14px] text-[--color-ink-2]">{row.count}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
