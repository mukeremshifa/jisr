import { getActor } from '@/lib/actor';
import { listAudit } from '@/lib/data';
import { Badge, Empty, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** HR and ops only. Security events, insert-only for the app role. */
export default async function AuditPage() {
  const actor = await getActor();
  if (!actor) return <Empty>Sign in.</Empty>;
  if (!actor.roles.hr && !actor.roles.opsAdmin) return <Empty>The audit log is for HR and ops.</Empty>;

  const rows = await listAudit(150);

  return (
    <div className="flex flex-col gap-[24px]">
      <SectionTitle right={<span className="label">{rows.length} most recent</span>}>Audit log</SectionTitle>

      {rows.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="board">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Actor</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap text-[--color-ink-2]">
                    {new Date(row.at).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })}
                  </td>
                  <td className="whitespace-nowrap">
                    {row.severity === 'critical' || row.severity === 'warn' ? (
                      <Badge tone={row.severity === 'critical' ? 'act' : 'outline'}>{row.event}</Badge>
                    ) : (
                      <span className="mono">{row.event}</span>
                    )}
                  </td>
                  <td className="mono whitespace-nowrap text-[--color-ink-3]">{row.actor ?? '–'}</td>
                  <td className="mono whitespace-nowrap text-[--color-ink-3]">{row.subject ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[12px] text-[--color-ink-3]">
        Phone numbers are never recorded here. A worker appears as an HMAC or a public reference. A speak-up
        reporter appears as nothing at all.
      </p>
    </div>
  );
}
