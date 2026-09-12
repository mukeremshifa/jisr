/**
 * `pnpm doctor`. Green means demo ready.
 *
 * It answers one question: if the demo started right now, would it work? So it
 * probes rather than guesses. Where a real call is cheap and safe it makes one
 * (the database, Slack, FGA); where a call would cost money or send a message
 * it checks that the credentials are complete and says so plainly.
 *
 * Each part of the extension pass that adds a dependency adds a check here:
 * the weather endpoint (B2), the voice-capable Twilio number (B8), the
 * guardrail step (B10), the Teams channel (B12).
 *
 * Exit code 0 when nothing is failing, 1 otherwise. Warnings never fail the
 * run: a feature that is switched off is not a problem.
 */
import { config, features, isConfigured } from '@jisr/core';

type Status = 'ok' | 'warn' | 'fail' | 'skip';

interface Result {
  group: string;
  name: string;
  status: Status;
  detail: string;
}

const results: Result[] = [];

function record(group: string, name: string, status: Status, detail: string): void {
  results.push({ group, name, status, detail });
}

/** Runs a probe, turning any throw into a failure rather than a crashed script. */
async function probe(group: string, name: string, fn: () => Promise<[Status, string]>): Promise<void> {
  try {
    const [status, detail] = await fn();
    record(group, name, status, detail);
  } catch (error) {
    record(group, name, 'fail', error instanceof Error ? error.message : String(error));
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

// ---------------------------------------------------------------- database

async function checkDatabase(): Promise<void> {
  if (!config.DATABASE_URL) {
    record('Database', 'reachable', 'fail', 'DATABASE_URL is unset');
    record('Database', 'migrated', 'skip', 'no database configured');
    return;
  }

  const { getSql, closeDb } = await import('@jisr/db');
  try {
    const sql = getSql();
    await probe('Database', 'reachable', async () => {
      const rows = await withTimeout(sql`select current_user as who, version() as version`, 10_000, 'database connect');
      const who = String(rows[0]?.who ?? 'unknown');
      const version = String(rows[0]?.version ?? '').split(' ').slice(0, 2).join(' ');
      return ['ok', `connected as ${who}, ${version}`];
    });

    await probe('Database', 'migrated', async () => {
      // The core tables the loop reads. If these are present the Drizzle
      // migrations ran; if the RLS policies are present the sql/ files did too.
      const expected = ['companies', 'sites', 'workers', 'cases', 'case_events', 'media', 'messages', 'broadcasts', 'broadcast_deliveries', 'audit_log'];
      const rows = await withTimeout(
        sql<{ table_name: string }[]>`
          select table_name from information_schema.tables
          where table_schema = 'public'
        `,
        10_000,
        'table listing',
      );
      const present = new Set(rows.map((r) => r.table_name));
      const missing = expected.filter((t) => !present.has(t));
      if (missing.length > 0) {
        return ['fail', `missing tables: ${missing.join(', ')}. Run pnpm db:migrate`];
      }

      const policies = await withTimeout(
        sql<{ count: string }[]>`select count(*)::text as count from pg_policies where schemaname = 'public'`,
        10_000,
        'policy listing',
      );
      const policyCount = Number(policies[0]?.count ?? 0);
      if (policyCount === 0) {
        return ['fail', `${expected.length} tables present but no RLS policies. Run pnpm db:migrate`];
      }
      return ['ok', `${present.size} tables, ${policyCount} RLS policies`];
    });
  } finally {
    await closeDb().catch(() => {});
  }
}

// ------------------------------------------------------------------ crypto

async function checkCrypto(): Promise<void> {
  const keys: Array<[string, string | undefined]> = [
    ['DATA_ENCRYPTION_KEY', config.DATA_ENCRYPTION_KEY],
    ['SEALING_KEY', config.SEALING_KEY],
    ['PHONE_HMAC_KEY', config.PHONE_HMAC_KEY],
  ];

  const decoded: Record<string, string> = {};
  for (const [name, raw] of keys) {
    if (!raw) {
      record('Crypto', name, 'fail', 'unset. Generate with: openssl rand -base64 32');
      continue;
    }
    const bytes = Buffer.from(raw.trim(), 'base64');
    if (bytes.length !== 32) {
      record('Crypto', name, 'fail', `decodes to ${bytes.length} bytes, needs exactly 32`);
      continue;
    }
    decoded[name] = bytes.toString('hex');
    record('Crypto', name, 'ok', '32 bytes');
  }

  // The three keys must be independent: leaking one must not unseal another.
  const values = Object.values(decoded);
  const unique = new Set(values);
  if (values.length > 1 && unique.size !== values.length) {
    record('Crypto', 'keys are distinct', 'fail', 'two or more keys are the same value');
  } else if (values.length > 1) {
    record('Crypto', 'keys are distinct', 'ok', `${values.length} independent keys`);
  }

  // A real round trip, so a key that is present but unusable still fails here.
  if (Object.keys(decoded).length === 3) {
    await probe('Crypto', 'round trip', async () => {
      const { encryptField, decryptField } = await import('@jisr/db');
      const secret = 'doctor probe value';
      const sealed = encryptField(secret, 'sealing');
      if (decryptField(sealed, 'sealing') !== secret) return ['fail', 'sealing key does not round trip'];
      const data = encryptField(secret, 'data');
      if (decryptField(data, 'data') !== secret) return ['fail', 'data key does not round trip'];
      // Cross-key decryption must fail: that is the whole point of two keys.
      try {
        decryptField(sealed, 'data');
        return ['fail', 'a sealing-key ciphertext decrypted with the data key'];
      } catch {
        return ['ok', 'encrypt and decrypt work, and the keys are not interchangeable'];
      }
    });
  }
}

// ---------------------------------------------------------------- WhatsApp

function checkWhatsApp(): void {
  const provider = config.WHATSAPP_PROVIDER;
  const required: Record<string, Array<Parameters<typeof isConfigured>[0]>> = {
    twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'],
    meta: ['META_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN', 'META_APP_SECRET', 'META_VERIFY_TOKEN'],
    kapso: ['KAPSO_API_KEY', 'KAPSO_PHONE_NUMBER_ID'],
  };

  const keys = required[provider] ?? [];
  const missing = keys.filter((k) => !isConfigured(k));
  if (missing.length > 0) {
    record('WhatsApp', `${provider} credentials`, 'fail', `missing: ${missing.join(', ')}`);
  } else {
    record('WhatsApp', `${provider} credentials`, 'ok', `WHATSAPP_PROVIDER=${provider}, all values set`);
  }

  // Twilio fetches outbound audio from a URL we host, so it needs storage.
  if (provider === 'twilio' && !isConfigured('GCS_BUCKET')) {
    record('WhatsApp', 'outbound voice notes', 'fail', 'Twilio fetches audio by URL, so GCS_BUCKET is required');
  } else if (provider === 'twilio') {
    record('WhatsApp', 'outbound voice notes', 'ok', 'GCS_BUCKET set, Twilio can fetch audio');
  } else {
    record('WhatsApp', 'outbound voice notes', 'ok', `${provider} hosts media itself, no object storage needed`);
  }

  if (!isConfigured('PUBLIC_GATEWAY_URL')) {
    record('WhatsApp', 'webhook URL', 'warn', 'PUBLIC_GATEWAY_URL unset, inbound webhooks cannot be verified');
  } else {
    record('WhatsApp', 'webhook URL', 'ok', String(config.PUBLIC_GATEWAY_URL));
  }
}

// ------------------------------------------------------------------- Slack

async function checkSlack(): Promise<void> {
  if (!isConfigured('SLACK_BOT_TOKEN')) {
    record('Slack', 'reachable', 'fail', 'SLACK_BOT_TOKEN is unset');
    return;
  }

  await probe('Slack', 'reachable', async () => {
    const res = await withTimeout(
      fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.SLACK_BOT_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      }),
      10_000,
      'Slack auth.test',
    );
    const body = (await res.json()) as { ok: boolean; team?: string; user?: string; error?: string };
    if (!body.ok) return ['fail', `auth.test returned ${body.error ?? 'not ok'}`];
    return ['ok', `authenticated as ${body.user ?? 'bot'} in ${body.team ?? 'workspace'}`];
  });

  if (!isConfigured('SLACK_SIGNING_SECRET')) {
    record('Slack', 'request signing', 'fail', 'SLACK_SIGNING_SECRET unset, interactions will be rejected');
  } else {
    record('Slack', 'request signing', 'ok', 'signing secret set');
  }

  const channels: Array<[string, string | undefined]> = [
    ['default', config.SLACK_DEFAULT_CHANNEL_ID],
    ['speak-up', config.SLACK_SPEAKUP_CHANNEL_ID],
    ['safety', config.SLACK_SAFETY_CHANNEL_ID],
    ['escalation', config.SLACK_ESCALATION_CHANNEL_ID],
  ];
  const unset = channels.filter(([, v]) => !v).map(([n]) => n);
  if (unset.length === channels.length) {
    record('Slack', 'channels', 'fail', 'no channel ids set, cards have nowhere to go');
  } else if (unset.length > 0) {
    record('Slack', 'channels', 'warn', `unset, will fall back to the default channel: ${unset.join(', ')}`);
  } else {
    record('Slack', 'channels', 'ok', 'all four routing channels set');
  }
}

// --------------------------------------------------------------------- FGA

async function checkFga(): Promise<void> {
  const { fga } = await import('@jisr/integrations');
  if (!fga.isFgaConfigured()) {
    record('Authorization', 'FGA reachable', 'fail', 'FGA_API_URL or FGA_STORE_ID is unset, every check would deny');
    return;
  }

  await probe('Authorization', 'FGA reachable', async () => {
    // A relation that really exists on the object type (can_view_cases is
    // defined on `site`), asked about a subject that does not. We are testing
    // that the store answers, and that it denies by default.
    const allowed = await withTimeout(
      fga.check({ user: 'user:doctor-probe-no-such-user', relation: 'can_view_cases', object: 'site:00000000-0000-0000-0000-000000000000' }),
      10_000,
      'FGA check',
    );
    if (allowed) return ['fail', 'the store granted a relation to a subject that does not exist'];
    return ['ok', 'store answered, and denied an unknown subject'];
  });
}

// ------------------------------------------------------------------ models

function checkModels(): void {
  if (!isConfigured('OPENAI_API_KEY')) {
    record('Models', 'primary', 'fail', 'OPENAI_API_KEY unset, there is no transcription or TTS');
  } else {
    record('Models', 'primary', 'ok', `OpenAI set, reasoning model ${config.OPENAI_REASONING_MODEL ?? 'gpt-4o-mini'}`);
  }

  if (!isConfigured('OPENROUTER_API_KEY')) {
    record('Models', 'fallback', 'warn', 'OPENROUTER_API_KEY unset, the model-outage drill cannot show a fallback');
  } else if (config.OPENROUTER_FALLBACK_MODELS.length === 0) {
    record('Models', 'fallback', 'warn', 'OpenRouter key set but OPENROUTER_FALLBACK_MODELS is empty');
  } else {
    record('Models', 'fallback', 'ok', `${config.OPENROUTER_FALLBACK_MODELS.length} fallback model(s) configured`);
  }

  if (config.FORCE_LLM_FALLBACK) {
    record('Models', 'FORCE_LLM_FALLBACK', 'warn', 'switched on, the primary model is being skipped');
  }
}

// ---------------------------------------------------------------- features

/**
 * One line per feature flag that is on, saying whether its dependencies are
 * satisfied. A flag that is off is not reported: it cannot break the demo.
 */
function checkFeatureFlags(): void {
  const flags: Array<{ name: string; on: boolean; needs: Array<Parameters<typeof isConfigured>[0]>; note?: string }> = [
    { name: 'FEATURE_TAP_TO_REPORT', on: features.tapToReport, needs: ['WHATSAPP_NUMBER_DIGITS'], note: 'sticker links need the wa.me number' },
    { name: 'FEATURE_SPEAKUP', on: features.speakup, needs: ['SEALING_KEY'] },
    { name: 'FEATURE_PAY_TWO_PERSON', on: features.payTwoPerson, needs: ['AUTH0_CIBA_CLIENT_ID', 'AUTH0_CIBA_CLIENT_SECRET'] },
    { name: 'FEATURE_DASHBOARD_COPILOT', on: features.dashboardCopilot, needs: ['OPENAI_API_KEY'] },
    { name: 'FEATURE_AMBIGUOUS_TASKS', on: features.ambiguousTasks, needs: ['AMBIGUOUS_MCP_URL', 'AMBIGUOUS_API_KEY'] },
  ];

  let anyOn = false;
  for (const flag of flags) {
    if (!flag.on) continue;
    anyOn = true;
    const missing = flag.needs.filter((k) => !isConfigured(k));
    if (missing.length > 0) {
      record('Feature flags', flag.name, 'fail', `on, but missing ${missing.join(', ')}${flag.note ? `. ${flag.note}` : ''}`);
    } else {
      record('Feature flags', flag.name, 'ok', 'on, dependencies satisfied');
    }
  }
  if (!anyOn) record('Feature flags', 'none on', 'warn', 'every feature flag is off');
}

// ------------------------------------------------------------------ output

const SYMBOL: Record<Status, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };

function report(): number {
  const groups = new Map<string, Result[]>();
  for (const r of results) {
    const list = groups.get(r.group) ?? [];
    list.push(r);
    groups.set(r.group, list);
  }

  let width = 0;
  for (const r of results) width = Math.max(width, r.name.length);

  const out: string[] = [''];
  for (const [group, list] of groups) {
    out.push(group);
    for (const r of list) {
      out.push(`  ${SYMBOL[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`);
    }
    out.push('');
  }

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');
  if (failures.length === 0) {
    out.push(`doctor green. ${results.length} checks, ${warnings.length} warning(s).`);
  } else {
    out.push(`doctor found ${failures.length} failure(s) and ${warnings.length} warning(s):`);
    for (const f of failures) out.push(`  ${f.group}: ${f.name}. ${f.detail}`);
  }
  out.push('');
  process.stdout.write(out.join('\n'));
  return failures.length === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  record('Environment', 'NODE_ENV', 'ok', config.NODE_ENV);
  record('Environment', 'company', 'ok', config.COMPANY_NAME);

  await checkDatabase();
  await checkCrypto();
  checkWhatsApp();
  await checkSlack();
  await checkFga();
  checkModels();
  checkFeatureFlags();

  process.exitCode = report();
}

main().catch((error: unknown) => {
  process.stderr.write(`doctor could not run: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
