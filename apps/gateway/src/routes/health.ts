import { Hono } from 'hono';
import { config, features, isConfigured } from '@jisr/core';

/**
 * Readiness, for Cloud Run and for the humans on demo day. It reports which
 * dependencies are wired without ever printing a secret — `set` or `unset` only.
 */
export const healthRoutes = new Hono();

healthRoutes.get('/healthz', (c) => c.json({ ok: true }));

healthRoutes.get('/readyz', (c) =>
  c.json({
    ok: true,
    env: config.NODE_ENV,
    features,
    wired: {
      database: isConfigured('DATABASE_URL'),
      twilio: isConfigured('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'),
      openai: isConfigured('OPENAI_API_KEY'),
      openrouter: isConfigured('OPENROUTER_API_KEY'),
      googleTts: isConfigured('GOOGLE_CLOUD_PROJECT'),
      gcs: isConfigured('GCS_BUCKET'),
      trigger: isConfigured('TRIGGER_SECRET_KEY'),
      slackWebApi: isConfigured('SLACK_BOT_TOKEN'),
      channels: isConfigured('INTELLIGENCE_API_KEY'),
      exa: isConfigured('EXA_API_KEY'),
      fga: isConfigured('FGA_STORE_ID'),
      ciba: isConfigured('AUTH0_CIBA_CLIENT_ID'),
      ambiguous: isConfigured('AMBIGUOUS_API_KEY'),
    },
  }),
);
