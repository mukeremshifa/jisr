import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NotConfiguredError, config, features, log } from '@jisr/core';

/**
 * Ambiguous, over its MCP server.
 *
 * We call `tools/list` first and match on the names the server actually returns,
 * rather than hard-coding tool names that may have changed. If nothing matches,
 * we say so and skip. Never a silent no-op that looks like a success.
 */

let client: Client | undefined;
let toolNames: string[] = [];

export function isAmbiguousConfigured(): boolean {
  return Boolean(config.AMBIGUOUS_API_KEY && config.AMBIGUOUS_MCP_URL);
}

async function connect(): Promise<Client> {
  if (client) return client;
  if (!isAmbiguousConfigured()) throw new NotConfiguredError('Ambiguous (AMBIGUOUS_API_KEY)');

  const transport = new StreamableHTTPClientTransport(new URL(config.AMBIGUOUS_MCP_URL!), {
    requestInit: { headers: { authorization: `Bearer ${config.AMBIGUOUS_API_KEY}` } },
  });

  const next = new Client({ name: 'jisr', version: '0.1.0' }, { capabilities: {} });
  await next.connect(transport);

  const listed = await next.listTools();
  toolNames = listed.tools.map((t) => t.name);
  log.info('ambiguous_tools_listed', { tools: toolNames });

  client = next;
  return next;
}

/** Finds the first tool whose name contains every one of `words`. */
function findTool(...words: string[]): string | null {
  const lowered = toolNames.map((n) => ({ name: n, lower: n.toLowerCase() }));
  const match = lowered.find((t) => words.every((w) => t.lower.includes(w.toLowerCase())));
  return match?.name ?? null;
}

export interface AmbiguousResult {
  ok: boolean;
  externalRef: string | null;
  detail: string;
}

/** C9 (flagged): mirror a routed case as a task. */
export async function createCaseTask(input: {
  casePublicId: string;
  title: string;
  summaryEn: string;
  dashboardUrl: string | null;
}): Promise<AmbiguousResult> {
  if (!features.ambiguousTasks) return { ok: false, externalRef: null, detail: 'feature flag off' };

  try {
    const mcp = await connect();
    const tool = findTool('task', 'create') ?? findTool('create', 'task') ?? findTool('task');
    if (!tool) return { ok: false, externalRef: null, detail: `no task tool in: ${toolNames.join(', ')}` };

    const result = await mcp.callTool({
      name: tool,
      arguments: {
        title: `${input.casePublicId}: ${input.title}`.slice(0, 120),
        description: `${input.summaryEn}\n\n${input.dashboardUrl ?? ''}`.trim(),
      },
    });
    return { ok: !result.isError, externalRef: extractRef(result), detail: tool };
  } catch (error) {
    log.warn('ambiguous_task_failed', { error });
    return { ok: false, externalRef: null, detail: String(error) };
  }
}

/**
 * F3 execution: append the approved adjustment to the payroll sheet. Idempotent
 * by `adjustmentId`. The caller passes the same id on every retry, and the row
 * carries it so a duplicate is visible rather than silent.
 */
export async function appendPayrollRow(input: {
  adjustmentId: string;
  casePublicId: string;
  workerPublicRef: string;
  period: string;
  kind: string;
  hours: string;
  amountAed: string;
  approvedBy: string;
  payloadSha256: string;
}): Promise<AmbiguousResult> {
  try {
    const mcp = await connect();
    const tool =
      findTool('row', 'append') ??
      findTool('sheet', 'append') ??
      findTool('row', 'add') ??
      findTool('sheet', 'insert') ??
      findTool('row', 'create');
    if (!tool) {
      return { ok: false, externalRef: null, detail: `no sheet-append tool in: ${toolNames.join(', ')}` };
    }

    const result = await mcp.callTool({
      name: tool,
      arguments: {
        sheet: config.AMBIGUOUS_PAYROLL_SHEET,
        row: {
          adjustment_id: input.adjustmentId,
          case_id: input.casePublicId,
          worker_ref: input.workerPublicRef,
          period: input.period,
          kind: input.kind,
          hours: input.hours,
          amount_aed: input.amountAed,
          approved_by: input.approvedBy,
          payload_sha256: input.payloadSha256,
          executed_at: new Date().toISOString(),
        },
      },
    });

    return {
      ok: !result.isError,
      externalRef: extractRef(result) ?? input.adjustmentId,
      detail: tool,
    };
  } catch (error) {
    log.error('ambiguous_payroll_append_failed', { adjustmentId: input.adjustmentId, error });
    return { ok: false, externalRef: null, detail: String(error) };
  }
}

function extractRef(result: unknown): string | null {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      const parsed = safeJson(part.text);
      const ref = parsed?.id ?? parsed?.rowId ?? parsed?.row_id ?? parsed?.ref;
      if (typeof ref === 'string') return ref;
    }
  }
  return null;
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function closeAmbiguous(): Promise<void> {
  await client?.close();
  client = undefined;
  toolNames = [];
}
