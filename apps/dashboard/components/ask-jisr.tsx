'use client';

import { CopilotKit, useCopilotAction, useCopilotReadable } from '@copilotkit/react-core';
import { CopilotSidebar } from '@copilotkit/react-ui';
import '@copilotkit/react-ui/styles.css';
import type { ReactNode } from 'react';
import type { CaseListItem } from '@/lib/dto';
import { AckChart, type AckChartData } from './ack-chart';
import { CaseTable } from './case-table';
import { SiteSummary } from './site-summary';

/**
 * The copilot renders its answers as the same components the pages use, so a
 * question and a page cannot show different numbers.
 *
 * These actions are render-only: the work happens server-side in
 * app/api/copilotkit/route.ts, where the FGA checks are.
 */

export interface PageContext {
  page: string;
  filters?: Record<string, string | undefined>;
  selectedCase?: string | null;
}

function Renderers(): null {
  useCopilotAction({
    name: 'searchCases',
    available: 'disabled',
    render: ({ status, result }) => {
      if (status !== 'complete') return <Loading>Looking through the cases…</Loading>;
      const cases = (result as { cases?: CaseListItem[] } | undefined)?.cases ?? [];
      return <CaseTable cases={cases} />;
    },
  });

  useCopilotAction({
    name: 'summarizeSite',
    available: 'disabled',
    render: ({ status, result }) => {
      if (status !== 'complete') return <Loading>Checking that site…</Loading>;
      const data = result as { siteName?: string; open?: number; pastSla?: number } | undefined;
      if (!data?.siteName) return <Note>I could not find that site.</Note>;
      return (
        <SiteSummary rows={[{ siteName: data.siteName, open: data.open ?? 0, pastSla: data.pastSla ?? 0 }]} />
      );
    },
  });

  useCopilotAction({
    name: 'broadcastStats',
    available: 'disabled',
    render: ({ status, result }) => {
      if (status !== 'complete') return <Loading>Counting acknowledgements…</Loading>;
      const rows = (result as { broadcasts?: AckChartData[] } | undefined)?.broadcasts ?? [];
      return <AckChart broadcasts={rows} />;
    },
  });

  useCopilotAction({
    name: 'draftBroadcast',
    available: 'disabled',
    render: ({ status, result }) => {
      if (status !== 'complete') return <Loading>Drafting…</Loading>;
      const data = result as { text?: string; siteName?: string | null } | undefined;
      return (
        <div className="card p-[16px]">
          <div className="label">Draft broadcast{data?.siteName ? ` · ${data.siteName}` : ''}</div>
          <p className="mt-[8px] text-[14px]" dir="auto">
            {data?.text}
          </p>
          <p className="mt-[8px] text-[12px] text-[--color-ink-3]">
            Nothing has been sent. Open Broadcasts, check every translation, then press Send.
          </p>
        </div>
      );
    },
  });

  return null;
}

function Loading({ children }: { children: ReactNode }) {
  return <div className="p-[16px] text-[13px] text-[--color-ink-3]">{children}</div>;
}

function Note({ children }: { children: ReactNode }) {
  return <div className="p-[16px] text-[13px]">{children}</div>;
}

function Context({ context }: { context: PageContext }) {
  useCopilotReadable({
    description: 'What the user is currently looking at in the dashboard',
    value: context,
  });
  return null;
}

export function AskJisr({
  children,
  context,
  enabled,
}: {
  children: ReactNode;
  context: PageContext;
  enabled: boolean;
}) {
  if (!enabled) return <>{children}</>;

  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <Context context={context} />
      <Renderers />
      <CopilotSidebar
        labels={{
          title: 'Ask Jisr',
          initial:
            "Ask me about what's open, who hasn't acknowledged a broadcast, or how a site is doing. I can draft a broadcast, but only a person can send one.",
        }}
        defaultOpen={false}
        clickOutsideToClose
      >
        {children}
      </CopilotSidebar>
    </CopilotKit>
  );
}
