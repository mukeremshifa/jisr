import Exa from 'exa-js';
import { NotConfiguredError, config, log } from '@jisr/core';

/**
 * C5 grounding. Search is restricted to an allowlist of official domains, and the
 * allowlist is enforced twice: in the request, and again on every result we keep.
 * Results are untrusted content. The caller wraps them before they reach a model.
 */

let client: Exa | undefined;

function getClient(): Exa {
  if (client) return client;
  if (!config.EXA_API_KEY) throw new NotConfiguredError('EXA_API_KEY');
  client = new Exa(config.EXA_API_KEY);
  return client;
}

export function isExaConfigured(): boolean {
  return Boolean(config.EXA_API_KEY);
}

export interface GroundedResult {
  title: string;
  url: string;
  text: string;
}

function hostAllowed(url: string, allowed: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowed.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export async function searchOfficialSources(query: string, limit = 3): Promise<GroundedResult[]> {
  const allowed = config.EXA_ALLOWED_DOMAINS;
  const response = await getClient().searchAndContents(query, {
    numResults: Math.min(limit * 2, 10),
    includeDomains: [...allowed],
    text: { maxCharacters: 1200 },
    type: 'auto',
  });

  const kept = (response.results ?? [])
    .filter((r) => typeof r.url === 'string' && hostAllowed(r.url, allowed))
    .slice(0, limit)
    .map((r) => ({
      title: String(r.title ?? '').slice(0, 200),
      url: String(r.url),
      text: String((r as { text?: string }).text ?? '').slice(0, 1200),
    }));

  log.info('exa_search', { query: query.slice(0, 120), returned: response.results?.length ?? 0, kept: kept.length });
  return kept;
}
