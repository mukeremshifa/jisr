import { redactPii } from './redact';

/**
 * Structured JSON logs. Two rules, enforced here rather than remembered at call sites:
 *  - secret-shaped keys never print their value,
 *  - free text is PII-scrubbed, so a phone number in a transcript cannot leak into logs.
 *
 * Phone numbers are logged as their HMAC by the caller (`phoneHmac`), never raw.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SECRET_KEY_RE = /(key|secret|token|password|authorization|signature|cookie)/i;
const PII_KEY_RE = /(phone|msisdn|from|to|whatsapp|email|reporter_worker|worker_phone)/i;
const TEXT_KEY_RE = /(text|transcript|summary|message|question|answer|body|note|reason)/i;

function scrubValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    if (PII_KEY_RE.test(key)) return '[redacted]';
    if (TEXT_KEY_RE.test(key)) return redactPii(value).text.slice(0, 500);
    return value.slice(0, 1000);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubValue(key, v));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubValue(k, v);
    return out;
  }
  return value;
}

export interface LogFields {
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  const record: Record<string, unknown> = {
    severity: level.toUpperCase(),
    time: new Date().toISOString(),
    message,
  };
  for (const [k, v] of Object.entries(fields)) record[k] = scrubValue(k, v);
  const line = JSON.stringify(record);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};

/** Security events also go to `audit_log`; this is the log-side half. */
export const SECURITY_EVENTS = [
  'twilio_signature_invalid',
  'slack_signature_invalid',
  'unknown_sender',
  'unknown_sticker_code',
  'rate_limited',
  'injection_suspected',
  'fga_denied',
  'auth_failed',
  'token_budget_tripped',
  'pay_requested',
  'pay_approved',
  'pay_denied',
  'pay_expired',
  'pay_executed',
  'pay_hash_mismatch',
  'identity_reveal_requested',
  'identity_reveal_approved',
  'admin_change',
  'media_rejected',
  'model_fallback_used',
  'model_unavailable',
] as const;

export type SecurityEvent = (typeof SECURITY_EVENTS)[number];
