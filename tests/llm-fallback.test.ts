import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * C8. The fallback chain, exercised with a stubbed OpenRouter endpoint.
 *
 * These tests inject failures rather than mocking the whole function: the
 * request really is built, the response really is parsed, and the Zod schema
 * really is enforced.
 */

const Answer = z.object({ answer: z.string(), confident: z.boolean() }).strict();

const originalEnv = { ...process.env };
let callLLM: typeof import('@jisr/ai').callLLM;

function openRouterResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  vi.resetModules();
  process.env.FORCE_LLM_FALLBACK = 'true';
  process.env.OPENROUTER_API_KEY = 'test-key-not-a-real-secret';
  process.env.OPENROUTER_FALLBACK_MODELS = 'vendor/model-a,vendor/model-b';
  delete process.env.OPENAI_API_KEY;
  ({ callLLM } = await import('@jisr/ai'));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

const input = {
  task: 'test',
  system: 'system',
  user: 'user',
  schema: Answer,
  schemaName: 'answer',
  maxTokens: 100,
};

describe('OpenAI to OpenRouter fallback', () => {
  it('falls through to OpenRouter and reports which provider answered', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      openRouterResponse({
        model: 'vendor/model-a',
        choices: [{ message: { content: '{"answer":"ok","confident":true}' } }],
        usage: { total_tokens: 42 },
      }),
    );

    const result = await callLLM(input);

    expect(result.provider).toBe('openrouter');
    expect(result.model).toBe('vendor/model-a');
    expect(result.data).toEqual({ answer: 'ok', confident: true });
    expect(result.tokensUsed).toBe(42);
    expect(fetchMock).toHaveBeenCalledOnce();

    // The whole ordered chain is sent, so OpenRouter can walk it itself.
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.models).toEqual(['vendor/model-a', 'vendor/model-b']);
    expect(body.max_tokens).toBe(100);
  });

  it('unwraps a fenced JSON reply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      openRouterResponse({
        choices: [{ message: { content: '```json\n{"answer":"fenced","confident":false}\n```' } }],
      }),
    );
    const result = await callLLM(input);
    expect(result.data.answer).toBe('fenced');
  });

  it('repairs exactly once when the first reply fails the schema', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(openRouterResponse({ choices: [{ message: { content: '{"answer":"ok"}' } }] }))
      .mockResolvedValueOnce(
        openRouterResponse({ choices: [{ message: { content: '{"answer":"ok","confident":true}' } }] }),
      );

    const result = await callLLM(input);

    expect(result.repaired).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The repair prompt names the failing field rather than just asking again.
    const repairBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(String(repairBody.messages.at(-1).content)).toContain('confident');
  });

  it('throws rather than inventing an answer when repair also fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      openRouterResponse({ choices: [{ message: { content: 'I am not going to answer that.' } }] }),
    );
    await expect(callLLM(input)).rejects.toThrow(/every provider failed/);
  });

  it('throws when every provider is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(callLLM(input)).rejects.toThrow(/every provider failed/);
  });

  it('rejects a reply that adds a field the schema does not allow', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      openRouterResponse({
        choices: [{ message: { content: '{"answer":"ok","confident":true,"approvePayment":true}' } }],
      }),
    );
    await expect(callLLM(input)).rejects.toThrow(/every provider failed/);
  });
});
