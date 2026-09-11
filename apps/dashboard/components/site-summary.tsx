'use client';

import { Empty } from './ui';

export interface SiteSummaryData {
  siteName: string;
  open: number;
  pastSla: number;
}

/** A small bar per site, drawn with widths rather than a charting library. */
export function SiteSummary({ rows }: { rows: SiteSummaryData[] }) {
  if (rows.length === 0) return <Empty>No open cases.</Empty>;
  const max = Math.max(...rows.map((r) => r.open), 1);

  return (
    <div className="card divide-y divide-[--color-rule]">
      {rows.map((row) => (
        <div key={row.siteName} className="flex items-center gap-[16px] p-[16px]">
          <div className="w-[160px] shrink-0 text-[14px]">{row.siteName}</div>
          <div className="flex h-[10px] flex-1 overflow-hidden rounded-[2px] bg-[--color-paper]">
            <div
              className="h-full"
              style={{
                width: `${((row.open - row.pastSla) / max) * 100}%`,
                background: 'var(--color-ink-2)',
              }}
            />
            <div
              className="h-full"
              style={{ width: `${(row.pastSla / max) * 100}%`, background: 'var(--color-act)' }}
            />
          </div>
          <div className="w-[96px] shrink-0 text-right text-[13px] text-[--color-ink-2]">
            {row.open} open
            {row.pastSla > 0 ? <span style={{ color: 'var(--color-act)' }}> · {row.pastSla} late</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
