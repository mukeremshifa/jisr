import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { features } from '@jisr/core';
import { getActor } from '@/lib/actor';
import { AskJisr } from '@/components/ask-jisr';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jisr ops',
  description: 'Cases, broadcasts, pay approvals, stickers and the audit log.',
  robots: { index: false, follow: false },
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/cases', label: 'Cases' },
  { href: '/broadcasts', label: 'Broadcasts' },
  { href: '/pay', label: 'Pay approvals' },
  { href: '/stickers', label: 'Stickers', role: 'opsAdmin' as const },
  { href: '/audit', label: 'Audit log', role: 'audit' as const },
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const actor = await getActor();
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  const visible = NAV.filter((item) => {
    if (!item.role) return true;
    if (item.role === 'opsAdmin') return actor?.roles.opsAdmin ?? false;
    return (actor?.roles.hr ?? false) || (actor?.roles.opsAdmin ?? false);
  });

  return (
    <html lang="en">
      <body>
        <AskJisr context={{ page: 'dashboard' }} enabled={features.dashboardCopilot && Boolean(actor)}>
          <div className="mx-auto max-w-[1180px] px-[24px] py-[24px]">
            <header className="mb-[32px] flex flex-wrap items-baseline justify-between gap-[16px] border-b border-[--color-rule] pb-[16px]">
              <div className="flex items-baseline gap-[24px]">
                <Link href="/" className="text-[15px] font-medium tracking-[-0.01em]">
                  Jisr
                </Link>
                <nav className="flex flex-wrap gap-[16px]">
                  {visible.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="text-[13px] text-[--color-ink-2] hover:text-[--color-ink]"
                    >
                      {item.label}
                    </Link>
                  ))}
                </nav>
              </div>
              <div className="text-[12px] text-[--color-ink-3]">
                {actor ? (
                  <span>
                    {actor.staff.displayName}
                    <span aria-hidden="true" className="mx-[8px] text-[--color-rule]">
                      |
                    </span>
                    <a href="/auth/logout" className="underline underline-offset-[3px]">
                      Sign out
                    </a>
                  </span>
                ) : (
                  <a href="/auth/login" className="underline underline-offset-[3px]">
                    Sign in
                  </a>
                )}
              </div>
            </header>

            <main>{children}</main>

            <footer className="mt-[64px] border-t border-[--color-rule] pt-[16px] text-[11px] text-[--color-ink-3]">
              Jisr is an assistant, not a person. It never promises an outcome a manager has not decided.
            </footer>
          </div>
        </AskJisr>
        {nonce ? <meta name="csp-nonce" content={nonce} /> : null}
      </body>
    </html>
  );
}
