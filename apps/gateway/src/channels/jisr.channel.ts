import { createChannel, defineChannelCommand } from '@copilotkit/channels';
import { tasks } from '@trigger.dev/sdk';
import { z } from 'zod';
import { log, sanitizeText } from '@jisr/core';
import { applyDecision } from '../routes/slack';

/**
 * The Jisr Channel, loaded by the CopilotKit Channels runtime.
 *
 * It handles everything conversational in Slack. Consequential work is not done
 * here: the command only *drafts* a broadcast (a human still presses Send), and
 * button clicks go through `applyDecision`, which re-validates the action against
 * the allowlisted catalog and checks FGA before completing the case's waitpoint.
 */

const broadcastCommand = defineChannelCommand({
  name: 'jisr',
  description: 'Jisr: broadcast a message to workers in their own languages',
  options: z.object({
    message: z.string().describe('What you want every worker to hear'),
  }),
  async handler(ctx) {
    const text = sanitizeText(String(ctx.options?.message ?? ''), 600);
    if (!text) {
      await ctx.thread.post('Usage: `/jisr <message>` - I will show every translation before anything is sent.');
      return;
    }

    await tasks.trigger('broadcast.compose', {
      source: 'slack' as const,
      // A Channels command handler replies into its own thread and is not given
      // the raw channel id, so the target sites are resolved from the requester's
      // own FGA-allowed sites instead. The HTTP command route, which does get a
      // channel id, scopes to that channel's site. See docs/decisions.md.
      slackChannelId: '',
      slackUserId: String(ctx.user?.id ?? ''),
      textEn: text,
    });

    await ctx.thread.post('Translating now. Nothing goes out until you press Send on the preview.');
  },
});

export const jisrChannel = createChannel({
  name: 'jisr',
  identifyUser: 'platform',
  commands: [broadcastCommand],
});

// Case card buttons. The card renders up to five, all with this id prefix.
for (let index = 0; index < 5; index++) {
  jisrChannel.onInteraction<{ caseId: string; action: string; params: Record<string, unknown> }>(
    `jisr_case_action_${index}`,
    async (ctx) => {
      const value = ctx.action.value;
      if (!value?.caseId || !value.action) return;
      await applyDecision({
        caseId: value.caseId,
        actionName: value.action,
        params: value.params ?? {},
        slackUserId: String(ctx.user?.id ?? ''),
      });
    },
  );
}

jisrChannel.onMention(async ({ thread }) => {
  // Jisr always says what it is. It never presents itself as a person.
  await thread.post(
    "I'm Jisr, an assistant. I bring workers' reports here and take your decisions back to them in their language. Use `/jisr <message>` to broadcast, or tap a button on a case card.",
  );
});

log.info('jisr_channel_defined', { commands: jisrChannel.commandNames });

export default jisrChannel;
