import { notFound } from 'next/navigation';
import { getActor } from '@/lib/actor';
import { getCase } from '@/lib/data';
import { Badge, BridgeRow, Empty, SectionTitle, SeverityMark } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * One case, with the bridge row on every message: the worker's own words beside
 * the English. A speak-up case shows the sealed badge and the synthetic audio
 * only — never a name, a number, or the reporter's own voice.
 */
export default async function CasePage({ params }: { params: Promise<{ publicId: string }> }) {
  const actor = await getActor();
  if (!actor) return <Empty>Sign in to see cases.</Empty>;

  const { publicId } = await params;
  const detail = await getCase(publicId.toUpperCase());
  // Not found and not allowed are the same answer, so a 404 leaks nothing.
  if (!detail) notFound();

  const { header, timeline } = detail;

  return (
    <div className="flex flex-col gap-[32px]">
      <header className="flex flex-col gap-[8px]">
        <div className="flex flex-wrap items-center gap-[16px]">
          <span className="mono text-[14px]">{header.publicId}</span>
          <span className="text-[14px] capitalize">{header.category}</span>
          <SeverityMark severity={header.severity} />
          <span className="text-[14px] text-[--color-ink-2]">
            {header.isSpeakup ? 'identity sealed' : (header.assetLabel ?? header.siteName ?? 'location unknown')}
          </span>
        </div>

        <div className="flex flex-wrap gap-[4px]">
          <Badge>{header.status.replace(/_/g, ' ')}</Badge>
          {header.isSpeakup ? <Badge>speak-up · sealed</Badge> : null}
          {header.pastSla ? <Badge tone="act">past SLA</Badge> : null}
          {!header.confirmedByWorker && !header.isSpeakup ? <Badge tone="outline">unconfirmed</Badge> : null}
          {header.needsReview ? <Badge tone="outline">needs review</Badge> : null}
          {header.injectionSuspected ? <Badge tone="outline">content flagged</Badge> : null}
          {header.workerRef ? <Badge tone="outline">{header.workerRef}</Badge> : null}
        </div>
      </header>

      <section className="card p-[24px]">
        <div className="label mb-[16px]">What was reported</div>
        <BridgeRow
          original={header.isSpeakup ? null : detail.transcriptOriginal}
          english={header.summaryEn}
          languageName={header.isSpeakup ? null : header.languageName}
        />
        {header.isSpeakup ? (
          <p className="mt-[16px] text-[12px] text-[--color-ink-3]">
            The original words and voice are not shown. HR sees a redacted summary and a synthetic re-voicing;
            replies reach the reporter without revealing who they are.
          </p>
        ) : null}
      </section>

      <section>
        <SectionTitle right={<span className="label">{timeline.length} entries</span>}>Timeline</SectionTitle>
        {timeline.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <ol className="card divide-y divide-[--color-rule]">
            {timeline.map((item) => (
              <li key={item.id} className="p-[24px]">
                <div className="mb-[8px] flex items-center justify-between gap-[16px]">
                  <span className="label">
                    {item.kind === 'event'
                      ? item.label
                      : item.direction === 'inbound'
                        ? header.isSpeakup
                          ? 'From the reporter'
                          : 'From the worker'
                        : 'From Jisr'}
                  </span>
                  <time className="label" dateTime={item.at}>
                    {new Date(item.at).toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: 'Asia/Dubai',
                    })}
                  </time>
                </div>

                {item.kind === 'message' ? (
                  <BridgeRow original={item.textOriginal} english={item.textEn} />
                ) : null}

                {item.mediaUrl && item.mediaKind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.mediaUrl}
                    alt="Photo sent with this report"
                    className="mt-[16px] max-h-[320px] rounded-[2px] border border-[--color-rule]"
                  />
                ) : null}

                {item.mediaUrl && item.mediaKind !== 'image' ? (
                  <audio controls src={item.mediaUrl} className="mt-[16px] w-full max-w-[420px]">
                    <track kind="captions" />
                  </audio>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <SectionTitle>Actions</SectionTitle>
        <div className="card p-[24px] text-[13px] text-[--color-ink-2]">
          {header.isSpeakup ? (
            <p>
              Speak-up reports are answered in their Slack thread, so the relay can redact and re-voice every
              reply on the way back.
            </p>
          ) : detail.canAct ? (
            <p>
              Decisions are taken on the case card in Slack, where the buttons are. That keeps one record of who
              decided what, and the worker hears the result as a voice note either way.
            </p>
          ) : (
            <p>You can see this case but cannot act on it.</p>
          )}
          <p className="mt-[8px]">
            Pay corrections are never approved here: they need two different people, and the second approves on
            their phone.
          </p>
        </div>
      </section>
    </div>
  );
}
