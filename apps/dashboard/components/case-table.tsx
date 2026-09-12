'use client';

import type { CaseListItem } from '@/lib/dto';
import { Ago, Badge, CaseLink, Empty, SeverityMark } from './ui';

/**
 * The case table, shared by the Cases page and by "Ask Jisr" when it answers a
 * question about cases. One rendering, so a copilot answer and a page cannot
 * drift apart.
 */
export function CaseTable({ cases }: { cases: CaseListItem[] }) {
  if (cases.length === 0) return <Empty>Nothing open here.</Empty>;

  return (
    <div className="card overflow-x-auto">
      <table className="board">
        <thead>
          <tr>
            <th>Case</th>
            <th>Category</th>
            <th>Severity</th>
            <th>Where</th>
            <th>Summary</th>
            <th>Age</th>
            <th>SLA</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((item) => (
            <tr key={item.publicId}>
              <td className="whitespace-nowrap">
                <CaseLink publicId={item.publicId} />
                {item.isSpeakup ? (
                  <div className="mt-[4px]">
                    <Badge>sealed</Badge>
                  </div>
                ) : null}
              </td>
              <td className="whitespace-nowrap capitalize">{item.category}</td>
              <td className="whitespace-nowrap">
                <SeverityMark severity={item.severity} />
              </td>
              <td className="whitespace-nowrap text-[--color-ink-2]">
                {item.isSpeakup ? '–' : (item.assetLabel ?? item.siteName ?? '–')}
              </td>
              <td className="max-w-[380px]">
                <span dir="auto">{item.summaryEn || '–'}</span>
                <div className="mt-[4px] flex flex-wrap gap-[4px]">
                  {!item.confirmedByWorker && !item.isSpeakup ? <Badge tone="outline">unconfirmed</Badge> : null}
                  {item.needsReview ? <Badge tone="outline">needs review</Badge> : null}
                  {item.injectionSuspected ? <Badge tone="outline">content flagged</Badge> : null}
                </div>
              </td>
              <td className="whitespace-nowrap">
                <Ago minutes={item.ageMinutes} />
              </td>
              <td className="whitespace-nowrap">
                {item.pastSla ? <Badge tone="act">past SLA</Badge> : <span className="text-[--color-ink-3]">ok</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
