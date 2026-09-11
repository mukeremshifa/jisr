import { getActor } from '@/lib/actor';
import { listBroadcasts, listSites } from '@/lib/data';
import { AckChart } from '@/components/ack-chart';
import { Empty, SectionTitle } from '@/components/ui';
import { BroadcastComposer } from './composer';

export const dynamic = 'force-dynamic';

/**
 * Compose in English, see every translation, then press Send. The composer only
 * ever *drafts*: the preview and the Send button are the human control, and the
 * fan-out happens in a Trigger.dev task.
 */
export default async function BroadcastsPage() {
  const actor = await getActor();
  if (!actor) return <Empty>Sign in to send broadcasts.</Empty>;

  const [sites, broadcasts] = await Promise.all([listSites(), listBroadcasts(10)]);

  return (
    <div className="flex flex-col gap-[48px]">
      <section>
        <SectionTitle>New broadcast</SectionTitle>
        <BroadcastComposer sites={sites} />
      </section>

      <section>
        <SectionTitle right={<span className="label">most recent first</span>}>Recent broadcasts</SectionTitle>
        <AckChart
          broadcasts={broadcasts.map((b) => ({
            publicId: b.publicId,
            textEn: b.textEn,
            acked: b.acked,
            total: b.total,
            pending: b.pending,
          }))}
        />
      </section>
    </div>
  );
}
