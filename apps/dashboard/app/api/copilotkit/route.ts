import { CopilotRuntime, OpenAIAdapter, copilotRuntimeNextJSAppRouterEndpoint } from '@copilotkit/runtime';
import OpenAI from 'openai';
import { config, features, models } from '@jisr/core';
import { getActor } from '@/lib/actor';
import { getCase, listBroadcasts, listCases, listSites } from '@/lib/data';

/**
 * "Ask Jisr" — the dashboard copilot.
 *
 * Every tool below runs **as the signed-in user**: it resolves the actor from
 * the session and goes through the same FGA-checked data layer the pages use.
 * There is no tool here that sends, approves, reveals or deletes anything. Those
 * need a button, and a person to press it.
 */

export const dynamic = 'force-dynamic';

const openai = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : undefined;

/**
 * Each tool's arguments and return value are checked here, where they are
 * written. The runtime types its `actions` generic from the *first* action's
 * parameter tuple, so a list of differently-shaped tools cannot be assigned to
 * it directly; that widening happens once, at the `new CopilotRuntime` call
 * below, rather than being spread across every tool.
 */
const jisrTools = [
    {
      name: 'searchCases',
      description:
        'Find cases the signed-in user is allowed to see. Use this for questions like "what is still open at Site B".',
      parameters: [
        { name: 'siteName', type: 'string', description: 'Site name or code to narrow to', required: false },
        {
          name: 'category',
          type: 'string',
          description: 'maintenance, pay, safety, accommodation, leave, transport or other',
          required: false,
        },
        { name: 'openOnly', type: 'boolean', description: 'Only cases that are still open', required: false },
      ],
      handler: async ({
        siteName,
        category,
        openOnly,
      }: {
        siteName?: string;
        category?: string;
        openOnly?: boolean;
      }) => {
        const actor = await getActor();
        if (!actor) return { error: 'not signed in' };

        const sites = await listSites();
        const site = siteName
          ? sites.find(
              (s) =>
                s.name.toLowerCase().includes(siteName.toLowerCase()) ||
                s.code.toLowerCase() === siteName.toLowerCase(),
            )
          : undefined;

        const cases = await listCases({
          ...(site ? { siteId: site.id } : {}),
          ...(category ? { category: category as never } : {}),
          openOnly: openOnly ?? true,
          limit: 40,
        });

        return { count: cases.length, cases };
      },
    },

    {
      name: 'getCase',
      description: 'Read one case by its public id, for example JS-7F3K.',
      parameters: [{ name: 'publicId', type: 'string', description: 'The case public id', required: true }],
      handler: async ({
        publicId }: { publicId: string }) => {
        const detail = await getCase(publicId.toUpperCase());
        // Not found and not allowed look identical on purpose.
        if (!detail) return { error: 'no such case, or you do not have access to it' };
        return {
          ...detail.header,
          transcriptOriginal: detail.transcriptOriginal,
          timeline: detail.timeline.slice(-12),
        };
      },
    },

    {
      name: 'broadcastStats',
      description: 'Acknowledgement numbers for recent broadcasts, including who has not acknowledged.',
      parameters: [
        { name: 'broadcastId', type: 'string', description: 'A specific broadcast public id', required: false },
      ],
      handler: async ({
        broadcastId }: { broadcastId?: string }) => {
        const rows = await listBroadcasts(10);
        const filtered = broadcastId
          ? rows.filter((r) => r.publicId.toLowerCase() === broadcastId.toLowerCase())
          : rows;
        return { broadcasts: filtered };
      },
    },

    {
      name: 'summarizeSite',
      description: 'How one site is doing right now: open cases, what is past SLA, and the categories.',
      parameters: [{ name: 'siteCode', type: 'string', description: 'Site code or name', required: true }],
      handler: async ({
        siteCode }: { siteCode: string }) => {
        const sites = await listSites();
        const site = sites.find(
          (s) =>
            s.code.toLowerCase() === siteCode.toLowerCase() ||
            s.name.toLowerCase().includes(siteCode.toLowerCase()),
        );
        if (!site) return { error: 'no such site, or you do not have access to it' };

        const cases = await listCases({ siteId: site.id, openOnly: true, limit: 100 });
        const byCategory = new Map<string, number>();
        for (const item of cases) byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);

        return {
          siteName: site.name,
          open: cases.length,
          pastSla: cases.filter((c) => c.pastSla).length,
          critical: cases.filter((c) => c.severity === 'critical').length,
          byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
        };
      },
    },

    {
      name: 'draftBroadcast',
      description:
        'Fill the broadcast composer with a draft. This never sends anything — a person still has to review every translation and press Send.',
      parameters: [
        { name: 'text', type: 'string', description: 'The message in English', required: true },
        { name: 'siteName', type: 'string', description: 'Which site it is for', required: false },
      ],
      handler: async ({
        text, siteName }: { text: string; siteName?: string }) => {
        const sites = await listSites();
        const site = siteName
          ? sites.find((s) => s.name.toLowerCase().includes(siteName.toLowerCase()))
          : undefined;
        return {
          drafted: true,
          text,
          siteId: site?.id ?? null,
          siteName: site?.name ?? null,
          note: 'Draft only. Open Broadcasts, check every translation, then press Send.',
        };
      },
    },
];

const runtime = new CopilotRuntime({
  actions: () => jisrTools as unknown as never,
});

export async function POST(request: Request): Promise<Response> {
  // The copilot is a feature like any other, and can be switched off.
  if (!features.dashboardCopilot || !openai) {
    return new Response(JSON.stringify({ error: 'Ask Jisr is not enabled' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Signed-in users only: the tools read company data.
  const actor = await getActor();
  if (!actor) return new Response(null, { status: 401 });

  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new OpenAIAdapter({ openai, model: models.reasoning }),
    endpoint: '/api/copilotkit',
  });

  return handleRequest(request);
}
