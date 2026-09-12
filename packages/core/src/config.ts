import { z } from 'zod';
import { ConfigError } from './errors';

/**
 * Config is read once, at module load, from process.env.
 * Nothing in here is optional-by-accident: a value is either required for boot
 * or has an explicit default. Secrets are never logged (see `redactedConfig`).
 */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v.toLowerCase() === 'true' || v === '1'));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int());

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const csv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? fallback
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Shown to workers in the first-contact notice and the unknown-number reply. */
  COMPANY_NAME: z.string().default('Al Noor Contracting'),

  /**
   * One Slack workspace serves one company in this build. A Slack interaction
   * carries no tenant of its own, so this is the company those interactions
   * resolve to. Multi-tenant Slack would key this off the installation id.
   */
  DEFAULT_COMPANY_ID: optionalString,

  PUBLIC_GATEWAY_URL: optionalString,
  PUBLIC_DASHBOARD_URL: optionalString,

  OPENAI_API_KEY: optionalString,
  OPENAI_REASONING_MODEL: optionalString,
  OPENAI_TRANSCRIBE_MODEL: optionalString,
  OPENAI_TTS_MODEL: optionalString,

  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_FALLBACK_MODELS: csv([]),

  GOOGLE_CLOUD_PROJECT: optionalString,
  GCS_BUCKET: optionalString,

  EXA_API_KEY: optionalString,
  EXA_ALLOWED_DOMAINS: csv(['u.ae', 'mohre.gov.ae']),

  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_WHATSAPP_FROM: optionalString,
  WHATSAPP_NUMBER_DIGITS: optionalString,

  /**
   * Meta WhatsApp Cloud API, the alternative to Twilio as the WhatsApp carrier.
   * WHATSAPP_PROVIDER picks which one the gateway and worker use; the rest of
   * the pipeline never knows the difference.
   */
  WHATSAPP_PROVIDER: z.enum(['twilio', 'meta', 'kapso']).default('twilio'),
  META_PHONE_NUMBER_ID: optionalString,
  META_ACCESS_TOKEN: optionalString,
  META_APP_SECRET: optionalString,
  /** Our own value, echoed back during Meta's webhook verification handshake. */
  META_VERIFY_TOKEN: optionalString,
  META_GRAPH_VERSION: z.string().default('v21.0'),

  /**
   * Kapso: a managed WhatsApp carrier in front of Meta. Its send API is
   * Meta-shaped, so only the base URL, the auth header and the webhook format
   * differ from the Meta adapter.
   */
  KAPSO_API_KEY: optionalString,
  KAPSO_PHONE_NUMBER_ID: optionalString,
  KAPSO_WEBHOOK_SECRET: optionalString,
  KAPSO_API_BASE: z.string().default('https://api.kapso.ai/meta/whatsapp/v24.0'),

  TRIGGER_SECRET_KEY: optionalString,
  TRIGGER_PROJECT_REF: optionalString,

  INTELLIGENCE_API_KEY: optionalString,
  SLACK_BOT_TOKEN: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  SLACK_APP_TOKEN: optionalString,

  // Routing destinations. Per-site channels live in the `sites` table; these are
  // the company-wide fallbacks so a misconfigured site still reaches someone.
  SLACK_DEFAULT_CHANNEL_ID: optionalString,
  SLACK_SPEAKUP_CHANNEL_ID: optionalString,
  SLACK_SAFETY_CHANNEL_ID: optionalString,
  SLACK_ESCALATION_CHANNEL_ID: optionalString,

  AUTH0_DOMAIN: optionalString,
  AUTH0_CLIENT_ID: optionalString,
  AUTH0_CLIENT_SECRET: optionalString,
  AUTH0_SECRET: optionalString,
  APP_BASE_URL: optionalString,

  AUTH0_CIBA_CLIENT_ID: optionalString,
  AUTH0_CIBA_CLIENT_SECRET: optionalString,
  AUTH0_CIBA_AUDIENCE: optionalString,
  AUTH0_CIBA_CHANNEL: z.enum(['push', 'email']).default('push'),

  FGA_API_URL: optionalString,
  FGA_STORE_ID: optionalString,
  FGA_MODEL_ID: optionalString,
  FGA_CLIENT_ID: optionalString,
  FGA_CLIENT_SECRET: optionalString,
  FGA_API_TOKEN_ISSUER: optionalString,
  FGA_API_AUDIENCE: optionalString,

  AMBIGUOUS_MCP_URL: optionalString,
  AMBIGUOUS_API_KEY: optionalString,
  AMBIGUOUS_PAYROLL_SHEET: z.string().default('Payroll adjustments'),

  DATABASE_URL: optionalString,
  DATABASE_URL_MIGRATOR: optionalString,

  DATA_ENCRYPTION_KEY: optionalString,
  SEALING_KEY: optionalString,
  PHONE_HMAC_KEY: optionalString,

  VENUE_LAT: optionalString,
  VENUE_LNG: optionalString,

  DEMO_SLA_MINUTES: int(3),
  PAY_OT_MULTIPLIER_BP: int(12500),
  PAY_NIGHT_OT_MULTIPLIER_BP: int(15000),
  DAILY_TOKEN_BUDGET: int(2_000_000),

  FEATURE_TAP_TO_REPORT: bool(true),
  FEATURE_SPEAKUP: bool(true),
  FEATURE_PAY_TWO_PERSON: bool(true),
  FEATURE_DASHBOARD_COPILOT: bool(true),
  FEATURE_AMBIGUOUS_TASKS: bool(false),

  CAP_INBOUND_PER_WORKER_PER_HOUR: int(20),
  CAP_AUDIO_SECONDS_PER_WORKER_PER_DAY: int(600),
  CAP_AUDIO_SECONDS_PER_MESSAGE: int(180),
  CAP_IMAGE_BYTES: int(10 * 1024 * 1024),
  CAP_AUDIO_BYTES: int(16 * 1024 * 1024),

  FORCE_LLM_FALLBACK: bool(false),
});

export type Config = z.infer<typeof EnvSchema>;

function load(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export const config: Config = load();

export const features = {
  tapToReport: config.FEATURE_TAP_TO_REPORT,
  speakup: config.FEATURE_SPEAKUP,
  payTwoPerson: config.FEATURE_PAY_TWO_PERSON,
  dashboardCopilot: config.FEATURE_DASHBOARD_COPILOT,
  ambiguousTasks: config.FEATURE_AMBIGUOUS_TASKS,
} as const;

/** Model IDs come from env, never hard-coded. These are the documented defaults. */
export const models = {
  reasoning: config.OPENAI_REASONING_MODEL ?? 'gpt-4o-mini',
  transcribe: config.OPENAI_TRANSCRIBE_MODEL ?? 'whisper-1',
  tts: config.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts',
  fallbackChain: config.OPENROUTER_FALLBACK_MODELS,
} as const;

const SECRET_KEY_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|SID|DATABASE_URL)$/;

/** Safe to log: secret-shaped values become `set` / `unset`, never their contents. */
export function redactedConfig(c: Config = config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? (v ? 'set' : 'unset') : v;
  }
  return out;
}

/** Throws when a required dependency is missing, listing every gap at once. */
export function requireConfig(keys: Array<keyof Config>, forWhat: string): void {
  const missing = keys.filter((k) => config[k] === undefined || config[k] === '');
  if (missing.length > 0) {
    throw new ConfigError(`${forWhat} needs: ${missing.join(', ')}`, { missing });
  }
}

export function isConfigured(...keys: Array<keyof Config>): boolean {
  return keys.every((k) => config[k] !== undefined && config[k] !== '');
}
