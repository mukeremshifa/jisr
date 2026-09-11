import { NextResponse } from 'next/server';
import { getActor } from '@/lib/actor';
import { listCases } from '@/lib/data';

/**
 * The live case list, polled by TanStack Query. Same data layer as the pages, so
 * the FGA checks cannot be bypassed by asking the API instead.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const actor = await getActor();
  if (!actor) return new NextResponse(null, { status: 401 });

  const url = new URL(request.url);
  const siteId = url.searchParams.get('site') ?? undefined;
  const category = url.searchParams.get('category') ?? undefined;

  const cases = await listCases({
    ...(siteId ? { siteId } : {}),
    ...(category ? { category: category as never } : {}),
    openOnly: url.searchParams.get('all') !== '1',
    limit: 100,
  });

  return NextResponse.json(
    { cases },
    { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } },
  );
}
