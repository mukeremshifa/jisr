import { Slack, slack, type SlackAdapter } from '@copilotkit/channels/slack';
import { config, log } from '@jisr/core';
import {
  setSlackTransport,
  slackWebApiTransport,
  type Block,
  type MessageRef,
  type SlackTransport,
} from '@jisr/integrations';

/**
 * CopilotKit Channels, the manager surface.
 *
 * Channels owns the *conversational* side of Slack: the `/jisr` command, replies
 * in a thread, "ask Jisr about this case". It is defined in `jisr.channel.ts`,
 * which the Channels runtime loads (`npx copilotkit@latest channels setup`).
 *
 * This file covers the other half: proactive posting. A Channel is runtime-driven
 * and cannot be started from inside our own process, so when a Slack app token is
 * configured we construct the Channels Slack adapter directly and render our cards
 * through it with `Slack.Raw`. Without one, the Slack Web API transport stays in
 * place. Both sit behind `SlackTransport`, so `notifyManagers`/`updateCaseCard`
 * never know which is running. See docs/decisions.md.
 */

let adapter: SlackAdapter | undefined;

function channelsTransport(slackAdapter: SlackAdapter): SlackTransport {
  const raw = (payload: { blocks: Block[]; text: string }) => [
    Slack.Raw({ value: { blocks: payload.blocks, text: payload.text } }),
  ];

  return {
    name: 'copilotkit-channels',

    async post(channelId, payload) {
      const ref = await slackAdapter.post({ channel: channelId }, raw(payload));
      return { channelId, messageTs: String(ref.id) };
    },

    async update(ref, payload) {
      await slackAdapter.update({ id: ref.messageTs, channel: ref.channelId }, raw(payload));
    },

    async postThreadReply(ref, payload) {
      const posted = await slackAdapter.post(
        { channel: ref.channelId, threadTs: ref.messageTs },
        raw({ blocks: payload.blocks ?? [], text: payload.text }),
      );
      return { channelId: ref.channelId, messageTs: String(posted.id) };
    },

    async openModal(triggerId, view) {
      // Channels has no modal primitive, and a trigger_id is only valid for a few
      // seconds, so this one call goes straight out over the Slack Web API. Under
      // Socket Mode there is no HTTP route to fall back to.
      await slackWebApiTransport.openModal(triggerId, view);
    },

    async lookupUser() {
      return null;
    },
  };
}

export async function startChannelsRuntime(): Promise<void> {
  if (!config.SLACK_BOT_TOKEN || !config.SLACK_APP_TOKEN) {
    log.info('channels_adapter_skipped', {
      reason: 'SLACK_BOT_TOKEN and SLACK_APP_TOKEN are both required',
    });
    return;
  }

  try {
    adapter = slack({
      botToken: config.SLACK_BOT_TOKEN,
      appToken: config.SLACK_APP_TOKEN,
      ...(config.SLACK_SIGNING_SECRET ? { signingSecret: config.SLACK_SIGNING_SECRET } : {}),
      socketMode: true,
    });
    setSlackTransport(channelsTransport(adapter));
    log.info('channels_adapter_ready', { intelligence: Boolean(config.INTELLIGENCE_API_KEY) });
  } catch (error) {
    // Falling back is fine; pretending it worked is not.
    log.error('channels_adapter_failed', { error });
  }
}

export function channelsAdapter(): SlackAdapter | undefined {
  return adapter;
}
