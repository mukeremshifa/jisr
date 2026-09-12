import { SocketModeClient } from '@slack/socket-mode';
import { config, log } from '@jisr/core';
import { handleInteraction, type SlackInteraction } from '../routes/slack';

/**
 * Slack Socket Mode, the interactivity transport.
 *
 * With Socket Mode enabled on the app, Slack never POSTs to a Request URL: it
 * pushes interactions down a WebSocket the app opens itself. That suits a laptop
 * demo, where a tunnel URL changes on every restart.
 *
 * The payload on the socket is byte-identical to the one the signed HTTP route
 * receives, so both hand off to the same `handleInteraction`. Authorization is
 * unchanged and still happens downstream in `applyDecision` (catalog re-validation
 * then FGA); this file only moves bytes.
 *
 * No signature check here on purpose: the socket is authenticated by the app-level
 * token at connect time, so there is no untrusted body to verify.
 */

let client: SocketModeClient | undefined;

export async function startSocketMode(): Promise<void> {
  if (!config.SLACK_APP_TOKEN) {
    log.info('socket_mode_skipped', { reason: 'SLACK_APP_TOKEN is not set' });
    return;
  }

  try {
    client = new SocketModeClient({ appToken: config.SLACK_APP_TOKEN });

    // Button clicks and modal submissions.
    client.on('interactive', async ({ ack, body }: { ack: () => Promise<void>; body: unknown }) => {
      // Ack inside Slack's 3s budget, then do the work. A slow decision must not
      // make Slack retry the click.
      await ack();
      const payload = body as SlackInteraction;
      void handleInteraction(payload).catch((error: unknown) =>
        log.error('slack_interaction_failed', { type: payload?.type, error }),
      );
    });

    client.on('slash_commands', async ({ ack }: { ack: (response?: unknown) => Promise<void> }) => {
      // The HTTP route owns `/jisr`; acknowledge so Slack does not show an error
      // if the command is invoked while Socket Mode is the active transport.
      await ack({ text: 'Use the dashboard or a case card button for now.' });
    });

    client.on('disconnected', () => log.warn('socket_mode_disconnected', {}));

    await client.start();
    log.info('socket_mode_ready', {});
  } catch (error) {
    // The gateway still serves webhooks without it; pretending it connected is
    // what would actually break the demo.
    log.error('socket_mode_failed', { error });
  }
}
