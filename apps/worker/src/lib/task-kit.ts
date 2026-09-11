import { task, tasks, type AnyTask } from '@trigger.dev/sdk';

/**
 * Two thin wrappers over the Trigger.dev SDK.
 *
 * `validatedTask` parses the incoming payload with Zod inside `run`, so no task
 * body ever sees an unvalidated payload - the same guarantee `schemaTask` gives,
 * with the payload type stated by the schema.
 *
 * `trigger`/`triggerAndWait` take a task id as a string so tasks can reference
 * each other without importing each other: the lifecycle is a cycle
 * (intake -> case -> pay -> case), and string ids are how that cycle is broken.
 */

/** The narrow slice of Zod a task actually needs to validate its payload. */
export interface Validator<T> {
  parse(input: unknown): T;
}

export interface ValidatedTaskOptions<TPayload, TResult> {
  id: string;
  schema: Validator<TPayload>;
  queue?: { name: string };
  maxDuration?: number;
  retry?: { maxAttempts: number };
  run: (payload: TPayload) => Promise<TResult>;
}

/** Nothing reads the returned task type; Trigger.dev discovers tasks by id. */
export function validatedTask<TPayload, TResult = unknown>(
  options: ValidatedTaskOptions<TPayload, TResult>,
): AnyTask {
  return task({
    id: options.id,
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.maxDuration ? { maxDuration: options.maxDuration } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    run: async (payload: unknown): Promise<TResult> => options.run(options.schema.parse(payload)),
  });
}

export interface TriggerOptions {
  concurrencyKey?: string;
  idempotencyKey?: string;
  delay?: string;
  ttl?: string;
}

export async function trigger(
  id: string,
  payload: Record<string, unknown>,
  options: TriggerOptions = {},
): Promise<void> {
  await tasks.trigger(id as never, payload as never, options as never);
}

export async function triggerAndWait(id: string, payload: Record<string, unknown>): Promise<void> {
  await tasks.triggerAndWait(id as never, payload as never);
}
