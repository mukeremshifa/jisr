import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { ModelUnavailableError, NotConfiguredError, config, log, models } from '@jisr/core';

/**
 * C8 — one model call, two providers, strict validation.
 *
 *   OpenAI (20s timeout, one retry)
 *     -> on error or timeout: OpenRouter, walking OPENROUTER_FALLBACK_MODELS in order
 *       -> on a schema failure: one repair attempt, showing the model its own error
 *         -> still failing: throw, and the caller routes the raw transcript to a
 *            human with a "needs review" badge. Jisr never invents an answer.
 *
 * Which provider answered is logged on every call, so the demo can show the
 * fallback happening rather than assert it.
 */

export interface LlmCallInput<TOut> {
  /** Short name used in logs and in the daily token budget. */
  task: string;
  system: string;
  user: string;
  schema: z.ZodType<TOut>;
  schemaName: string;
  maxTokens: number;
  /** Images for the vision path, as data URLs or signed HTTPS URLs. */
  imageUrls?: string[];
  temperature?: number;
}

export interface LlmCallResult<T> {
  data: T;
  provider: 'openai' | 'openrouter';
  model: string;
  repaired: boolean;
  tokensUsed: number;
}

const OPENAI_TIMEOUT_MS = 20_000;

/**
 * Models from gpt-5.5 onward reject `temperature` outright: only the default (1)
 * is accepted, and anything else is a 400. Call sites still ask for 0 to 0.2
 * because that is the right intent for extraction, so the intent is honoured
 * where the model supports it and dropped where it would fail the call.
 */
const REJECTS_TEMPERATURE = /^(?:gpt-5\.(?:[5-9]|\d{2,})|gpt-[6-9]|gpt-\d{2,})/;

let openai: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (openai) return openai;
  if (!config.OPENAI_API_KEY) throw new NotConfiguredError('OPENAI_API_KEY');
  openai = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS, maxRetries: 1 });
  return openai;
}

type Content =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

function userContent(input: LlmCallInput<unknown>): Content {
  if (!input.imageUrls?.length) return input.user;
  return [
    { type: 'text' as const, text: input.user },
    ...input.imageUrls.slice(0, 3).map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ];
}

export async function callLLM<TOut>(input: LlmCallInput<TOut>): Promise<LlmCallResult<TOut>> {
  const started = Date.now();

  // FORCE_LLM_FALLBACK is a demo switch: it proves the fallback chain works
  // without anyone having to revoke a key on stage.
  if (!config.FORCE_LLM_FALLBACK && config.OPENAI_API_KEY) {
    try {
      const result = await callOpenAI(input);
      log.info('llm_call', {
        task: input.task,
        provider: result.provider,
        model: result.model,
        repaired: result.repaired,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      log.warn('llm_primary_failed', { task: input.task, error });
    }
  }

  try {
    const result = await callOpenRouter(input);
    log.warn('model_fallback_used', {
      task: input.task,
      provider: result.provider,
      model: result.model,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    log.error('model_unavailable', { task: input.task, error });
    throw new ModelUnavailableError(`every provider failed for task ${input.task}`, {
      task: input.task,
    });
  }
}

async function callOpenAI<TOut>(input: LlmCallInput<TOut>): Promise<LlmCallResult<TOut>> {
  const client = getOpenAI();
  const model = models.reasoning;

  const request = async (extraUser?: string) =>
    client.chat.completions.create({
      model,
      max_completion_tokens: input.maxTokens,
      ...(input.temperature === undefined || REJECTS_TEMPERATURE.test(model)
        ? {}
        : { temperature: input.temperature }),
      response_format: zodResponseFormat(input.schema as never, input.schemaName),
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: userContent(input) as never },
        ...(extraUser ? [{ role: 'user' as const, content: extraUser }] : []),
      ],
    });

  const first = await request();
  const parsed = parseAndValidate(input.schema, first.choices[0]?.message?.content ?? '');
  if (parsed.ok) {
    return {
      data: parsed.value,
      provider: 'openai',
      model,
      repaired: false,
      tokensUsed: first.usage?.total_tokens ?? 0,
    };
  }

  // One repair attempt. The model sees exactly what failed, nothing else.
  const second = await request(
    `Your previous reply did not match the required schema. Fix it and reply with JSON only.\nErrors: ${parsed.error}`,
  );
  const repaired = parseAndValidate(input.schema, second.choices[0]?.message?.content ?? '');
  if (!repaired.ok) throw new Error(`openai schema validation failed twice: ${repaired.error}`);

  return {
    data: repaired.value,
    provider: 'openai',
    model,
    repaired: true,
    tokensUsed: (first.usage?.total_tokens ?? 0) + (second.usage?.total_tokens ?? 0),
  };
}

async function callOpenRouter<TOut>(input: LlmCallInput<TOut>): Promise<LlmCallResult<TOut>> {
  if (!config.OPENROUTER_API_KEY) throw new NotConfiguredError('OPENROUTER_API_KEY');
  const chain = models.fallbackChain;
  if (chain.length === 0) throw new NotConfiguredError('OPENROUTER_FALLBACK_MODELS');

  const body = (extraUser?: string) => ({
    // OpenRouter walks this list itself and answers with whichever model replied.
    models: chain,
    max_tokens: input.maxTokens,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    response_format: zodResponseFormat(input.schema as never, input.schemaName),
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: userContent(input) },
      ...(extraUser ? [{ role: 'user', content: extraUser }] : []),
    ],
  });

  const post = async (extraUser?: string) => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        // OpenRouter asks callers to identify themselves.
        'HTTP-Referer': config.PUBLIC_DASHBOARD_URL ?? 'https://github.com',
        'X-Title': 'Jisr',
      },
      body: JSON.stringify(body(extraUser)),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`openrouter ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
  };

  const first = await post();
  const parsed = parseAndValidate(input.schema, first.choices?.[0]?.message?.content ?? '');
  if (parsed.ok) {
    return {
      data: parsed.value,
      provider: 'openrouter',
      model: first.model ?? chain[0]!,
      repaired: false,
      tokensUsed: first.usage?.total_tokens ?? 0,
    };
  }

  const second = await post(
    `Your previous reply did not match the required schema. Fix it and reply with JSON only.\nErrors: ${parsed.error}`,
  );
  const repaired = parseAndValidate(input.schema, second.choices?.[0]?.message?.content ?? '');
  if (!repaired.ok) throw new Error(`openrouter schema validation failed twice: ${repaired.error}`);

  return {
    data: repaired.value,
    provider: 'openrouter',
    model: second.model ?? chain[0]!,
    repaired: true,
    tokensUsed: (first.usage?.total_tokens ?? 0) + (second.usage?.total_tokens ?? 0),
  };
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseAndValidate<TOut>(schema: z.ZodType<TOut>, raw: string): ParseResult<TOut> {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'empty response' };

  // Some models wrap JSON in a fenced block even when asked not to.
  const unfenced = text.startsWith('```')
    ? text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    : text;

  let json: unknown;
  try {
    json = JSON.parse(unfenced);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }

  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
  };
}

export function isLlmConfigured(): boolean {
  return Boolean(config.OPENAI_API_KEY || (config.OPENROUTER_API_KEY && models.fallbackChain.length > 0));
}
