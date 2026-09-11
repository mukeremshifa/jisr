import { config, stickerUrl } from '@jisr/core';
import { getActor } from '@/lib/actor';
import { listAssets } from '@/lib/data';
import { Badge, Empty, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** F1 — ops_admin only. The printable sheet itself comes from `pnpm stickers`. */
export default async function StickersPage() {
  const actor = await getActor();
  if (!actor) return <Empty>Sign in.</Empty>;
  if (!actor.roles.opsAdmin) return <Empty>Stickers are managed by ops admins.</Empty>;

  const assets = await listAssets();
  const digits = config.WHATSAPP_NUMBER_DIGITS;

  return (
    <div className="flex flex-col gap-[24px]">
      <SectionTitle right={<span className="label">{assets.length} assets</span>}>Stickers</SectionTitle>

      <div className="card p-[24px] text-[13px] text-[--color-ink-2]">
        <p>
          A sticker turns a place into an entry point. Scanning it opens WhatsApp with the code already typed;
          the worker only presses send, then speaks. The code adds context — it grants no access, and the roster
          check and rate limits still apply.
        </p>
        <p className="mt-[8px]">
          Print a sheet with <code className="mono">pnpm stickers</code> (all assets) or{' '}
          <code className="mono">pnpm stickers R214 BUS07</code> (a few). It writes an A4 page of eight to{' '}
          <code className="mono">tmp/stickers.html</code>.
        </p>
      </div>

      {assets.length === 0 ? (
        <Empty>No assets yet.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="board">
            <thead>
              <tr>
                <th>Code</th>
                <th>Label</th>
                <th>Kind</th>
                <th>Site</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.id}>
                  <td className="mono whitespace-nowrap">{asset.code}</td>
                  <td>
                    {asset.label}
                    {!asset.active ? (
                      <div className="mt-[4px]">
                        <Badge tone="outline">inactive</Badge>
                      </div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap capitalize text-[--color-ink-2]">{asset.kind}</td>
                  <td className="whitespace-nowrap text-[--color-ink-2]">{asset.siteName ?? '—'}</td>
                  <td className="mono break-all text-[--color-ink-3]">
                    {digits ? stickerUrl(digits, asset.code) : 'set WHATSAPP_NUMBER_DIGITS'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
