import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The whole visual vocabulary, in one file. Grayscale by default; the "act"
 * colour appears only where something is past its SLA or critical.
 */

export function Badge({
  children,
  tone = 'quiet',
}: {
  children: ReactNode;
  tone?: 'quiet' | 'act' | 'outline';
}): ReactNode {
  const styles = {
    quiet: 'bg-[--color-paper] text-[--color-ink-2] border-[--color-rule]',
    act: 'bg-[--color-act-soft] text-[--color-act] border-[--color-act]',
    outline: 'bg-transparent text-[--color-ink-3] border-[--color-rule-strong]',
  }[tone];

  return (
    <span className={`inline-block border px-[6px] py-[1px] text-[11px] leading-[16px] rounded-[2px] ${styles}`}>
      {children}
    </span>
  );
}

export function SeverityMark({ severity }: { severity: string }): ReactNode {
  const isAct = severity === 'critical';
  return (
    <span className="inline-flex items-center gap-[6px]">
      <span
        aria-hidden
        className="inline-block h-[8px] w-[8px] rounded-full border"
        style={{
          background: isAct ? 'var(--color-act)' : severity === 'high' ? 'var(--color-ink-2)' : 'transparent',
          borderColor: isAct ? 'var(--color-act)' : 'var(--color-rule-strong)',
        }}
      />
      <span className={isAct ? 'text-[--color-act]' : 'text-[--color-ink-2]'}>{severity}</span>
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  act = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  act?: boolean;
}): ReactNode {
  return (
    <div className="card p-[16px]">
      <div className="label">{label}</div>
      <div
        className="mt-[8px] text-[28px] leading-[32px]"
        style={act ? { color: 'var(--color-act)' } : undefined}
      >
        {value}
      </div>
      {hint ? <div className="mt-[4px] text-[12px] text-[--color-ink-3]">{hint}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <div className="mb-[16px] flex items-baseline justify-between gap-[16px]">
      <h2 className="text-[13px] font-medium tracking-[0.01em]">{children}</h2>
      {right}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="p-[32px] text-center text-[13px] text-[--color-ink-3]">{children}</div>;
}

/**
 * The signature row: the worker's words on the left in their own script, the
 * English on the right. `dir="auto"` so Urdu and Arabic lay out correctly
 * without us having to know which is which at render time.
 */
export function BridgeRow({
  original,
  english,
  languageName,
}: {
  original: string | null;
  english: string | null;
  languageName?: string | null;
}): ReactNode {
  if (!original && !english) return null;
  return (
    <div className="bridge">
      <div>
        <p className="bridge-original" dir="auto">
          {original ?? <span className="text-[--color-ink-3]">—</span>}
        </p>
        {languageName ? <div className="label mt-[4px]">{languageName}</div> : null}
      </div>
      <div>
        <p className="bridge-english" dir="auto">
          {english ?? <span className="text-[--color-ink-3]">—</span>}
        </p>
        {languageName ? <div className="label mt-[4px]">English</div> : null}
      </div>
    </div>
  );
}

export function CaseLink({ publicId }: { publicId: string }): ReactNode {
  return (
    <Link href={`/cases/${publicId}`} className="mono underline underline-offset-[3px] hover:text-[--color-act]">
      {publicId}
    </Link>
  );
}

export function Ago({ minutes }: { minutes: number }): ReactNode {
  const text =
    minutes < 60
      ? `${minutes}m`
      : minutes < 60 * 24
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / (60 * 24))}d`;
  return <span className="text-[--color-ink-2]">{text}</span>;
}
