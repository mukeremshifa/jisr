import { getActor } from '@/lib/actor';
import { listPayApprovals } from '@/lib/data';
import { Badge, CaseLink, Empty, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Read-only, by design. The dashboard can show a pay approval and who approved
 * it; it can never approve one. Two different people approve, and the second
 * approves on their phone through Auth0.
 */
export default async function PayPage() {
  const actor = await getActor();
  if (!actor) return <Empty>Sign in to see pay approvals.</Empty>;

  const rows = await listPayApprovals(50);
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-[24px]">
        <SectionTitle>Pay approvals</SectionTitle>
        <Empty>
          {actor.roles.hr || actor.roles.opsAdmin
            ? 'No pay corrections yet.'
            : 'Pay approvals are visible to HR and ops only.'}
        </Empty>
      </div>
    );
  }

  const queue = rows.filter((row) => ['proposed', 'pending_supervisor', 'pending_hr'].includes(row.status));
  const history = rows.filter((row) => !queue.includes(row));

  return (
    <div className="flex flex-col gap-[48px]">
      <section>
        <SectionTitle right={<span className="label">read-only</span>}>Waiting</SectionTitle>
        <PayTable rows={queue} emptyText="Nothing waiting." />
      </section>

      <section>
        <SectionTitle>History</SectionTitle>
        <PayTable rows={history} emptyText="No decided corrections yet." />
      </section>

      <p className="text-[12px] text-[--color-ink-3]">
        Amounts are calculated on the server from the roster rate. The hash binds what was approved to what is
        executed: if the numbers change in between, the payment is refused and a critical audit event is written.
      </p>
    </div>
  );
}

function PayTable({
  rows,
  emptyText,
}: {
  rows: Awaited<ReturnType<typeof listPayApprovals>>;
  emptyText: string;
}) {
  if (rows.length === 0) return <Empty>{emptyText}</Empty>;

  return (
    <div className="card overflow-x-auto">
      <table className="board">
        <thead>
          <tr>
            <th>Case</th>
            <th>Worker</th>
            <th>Period</th>
            <th>Hours</th>
            <th>Amount</th>
            <th>Approved by</th>
            <th>Hash</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <CaseLink publicId={row.casePublicId} />
              </td>
              <td className="whitespace-nowrap">{row.workerRef}</td>
              <td className="whitespace-nowrap">{row.period}</td>
              <td className="whitespace-nowrap">{row.hours}</td>
              <td className="whitespace-nowrap">AED {row.amountAed}</td>
              <td className="whitespace-nowrap text-[--color-ink-2]">
                {row.proposedBy ?? '—'}
                {row.approvedBy ? <> {'→'} {row.approvedBy}</> : null}
              </td>
              <td className="mono whitespace-nowrap text-[--color-ink-3]">{row.hashShort}</td>
              <td className="whitespace-nowrap">
                <Badge tone={row.status === 'denied' || row.status === 'expired' ? 'act' : 'quiet'}>
                  {row.status.replace(/_/g, ' ')}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
