import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { log, redactedConfig } from '@jisr/core';
import { bodyLimit, requestLog, securityHeaders } from './middleware/security';
import { healthRoutes } from './routes/health';
import { twilioRoutes } from './routes/twilio';
import { slackRoutes } from './routes/slack';
import { startChannelsRuntime } from './channels/runtime';

/**
 * The Jisr gateway.
 *
 * Thin by design: validate, persist, enqueue. Everything slow or flaky happens in
 * a Trigger.dev task where it gets retries, timeouts and a trace.
 *
 * No CORS headers (server-to-server only), no static files, no debug routes, and
 * a bare 404 for anything unrecognised.
 */

const app = new Hono();

app.use('*', requestLog);
app.use('*', securityHeaders);
app.use('/webhooks/*', bodyLimit(64 * 1024));
app.use('/slack/*', bodyLimit(64 * 1024));

app.route('/', healthRoutes);
app.route('/', twilioRoutes);
app.route('/', slackRoutes);

app.notFound((c) => c.text('', 404));

app.onError((error, c) => {
  // Never leak a stack trace to a caller.
  log.error('unhandled_error', { path: c.req.path, error });
  return c.text('', 500);
});

const port = Number(process.env.PORT ?? 8080);

serve({ fetch: app.fetch, port }, (info) => {
  log.info('gateway_started', { port: info.port, config: redactedConfig() });
});

// Channels keeps a persistent connection to CopilotKit Intelligence, which is why
// Cloud Run runs this service with min-instances 1 and CPU always allocated.
void startChannelsRuntime();

export { app };
