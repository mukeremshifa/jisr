import Link from 'next/link';
import type { CaseCategory, CaseStatus } from '@jisr/core';
import { getActor } from '@/lib/actor';
import { listCases, listSites } from '@/lib/data';
import { CaseTable } from '@/components/case-table';
import { Empty, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

const CATEGORIES = ['maintenance', 'pay', 'safety', 'accommodation', 'leave', 'transport', 'other'];

/**
 * Filters live in the URL so a link is shareable, and they are re-checked on the
 * server: a site id in a query string can only narrow what FGA already allows.
 */
export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) return <Empty>Sign in to see cases.</Empty>;

  const params = await searchParams;
  const siteId = typeof params.site === 'string' ? params.site : undefined;
  const category = typeof params.category === 'string' ? params.category : undefined;
  const openOnly = params.all !== '1';

  const [sites, cases] = await Promise.all([
    listSites(),
    listCases({
      ...(siteId ? { siteId } : {}),
      ...(category ? { category: category as CaseCategory } : {}),
      openOnly,
      limit: 100,
    }),
  ]);

  const link = (next: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    const merged = { site: siteId, category, all: openOnly ? undefined : '1', ...next };
    for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
    const search = query.toString();
    return search ? `/cases?${search}` : '/cases';
  };

  return (
    <div className="flex flex-col gap-[24px]">
      <SectionTitle right={<span className="label">{cases.length} shown</span>}>Cases</SectionTitle>

      <div className="flex flex-wrap items-center gap-[16px] text-[12px]">
        <FilterGroup label="Site">
          <FilterLink href={link({ site: undefined })} active={!siteId}>
            All
          </FilterLink>
          {sites.map((site) => (
            <FilterLink key={site.id} href={link({ site: site.id })} active={siteId === site.id}>
              {site.name}
            </FilterLink>
          ))}
        </FilterGroup>

        <FilterGroup label="Category">
          <FilterLink href={link({ category: undefined })} active={!category}>
            All
          </FilterLink>
          {CATEGORIES.map((item) => (
            <FilterLink key={item} href={link({ category: item })} active={category === item}>
              {item}
            </FilterLink>
          ))}
        </FilterGroup>

        <FilterGroup label="Status">
          <FilterLink href={link({ all: undefined })} active={openOnly}>
            Open
          </FilterLink>
          <FilterLink href={link({ all: '1' })} active={!openOnly}>
            Everything
          </FilterLink>
        </FilterGroup>
      </div>

      <CaseTable cases={cases} />
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[8px]">
      <span className="label">{label}</span>
      <div className="flex flex-wrap gap-[4px]">{children}</div>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-[2px] border px-[8px] py-[2px] capitalize ${
        active
          ? 'border-[--color-ink] bg-[--color-ink] text-[--color-card]'
          : 'border-[--color-rule] text-[--color-ink-2] hover:border-[--color-rule-strong]'
      }`}
    >
      {children}
    </Link>
  );
}
