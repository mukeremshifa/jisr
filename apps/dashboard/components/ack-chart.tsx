'use client';

import { Empty } from './ui';

export interface AckChartData {
  publicId: string;
  textEn: string;
  acked: number;
  total: number;
  pending: string[];
}

/** Acknowledgement progress for one broadcast, plus who is still missing. */
export function AckChart({ broadcasts }: { broadcasts: AckChartData[] }) {
  if (broadcasts.length === 0) return <Empty>No broadcasts yet.</Empty>;

  return (
    <div className="card divide-y divide-[--color-rule]">
      {broadcasts.map((row) => {
        const ratio = row.total === 0 ? 0 : row.acked / row.total;
        const complete = row.total > 0 && row.acked === row.total;
        return (
          <div key={row.publicId} className="p-[16px]">
            <div className="flex items-baseline justify-between gap-[16px]">
              <span className="mono">{row.publicId}</span>
              <span className="text-[13px] text-[--color-ink-2]">
                {row.acked} of {row.total} heard it
              </span>
            </div>
            <p className="mt-[8px] text-[14px]" dir="auto">
              {row.textEn}
            </p>
            <div className="mt-[8px] h-[10px] overflow-hidden rounded-[2px] bg-[--color-paper]">
              <div
                className="h-full"
                style={{
                  width: `${ratio * 100}%`,
                  background: complete ? 'var(--color-ink-2)' : 'var(--color-ink-3)',
                }}
              />
            </div>
            {row.pending.length > 0 ? (
              <div className="mt-[8px] text-[12px] text-[--color-ink-3]">
                Waiting on {row.pending.slice(0, 12).join(', ')}
                {row.pending.length > 12 ? ` +${row.pending.length - 12} more` : ''}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
