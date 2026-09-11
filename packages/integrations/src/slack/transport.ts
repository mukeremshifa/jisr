import { WebClient } from '@slack/web-api';
import { NotConfiguredError, config, log } from '@jisr/core';
import type { Block } from './blocks';

/**
 * Slack has exactly two entry points for case traffic — `notifyManagers` and
 * `updateCaseCard` (see `managerChannel.ts`). This file is the transport those
 * two sit on, so swapping Channels for the Web API never touches a caller.
 */

export interface MessageRef {
  channelId: string;
  messageTs: string;
}

export interface SlackTransport {
  readonly name: 'slack-web-api' | 'copilotkit-channels';
  post(channelId: string, payload: { blocks: Block[]; text: string }): Promise<MessageRef>;
  update(ref: MessageRef, payload: { blocks: Block[]; text: string }): Promise<void>;
  postThreadReply(ref: MessageRef, payload: { blocks?: Block[]; text: string }): Promise<MessageRef>;
  openModal(triggerId: string, view: Record<string, unknown>): Promise<void>;
  lookupUser(userId: string): Promise<{ id: string; name: string; email: string | null } | null>;
}

let web: WebClient | undefined;

function getWeb(): WebClient {
  if (web) return web;
  if (!config.SLACK_BOT_TOKEN) throw new NotConfiguredError('SLACK_BOT_TOKEN');
  web = new WebClient(config.SLACK_BOT_TOKEN, { retryConfig: { retries: 2 } });
  return web;
}

export function isSlackWebApiConfigured(): boolean {
  return Boolean(config.SLACK_BOT_TOKEN);
}

export const slackWebApiTransport: SlackTransport = {
  name: 'slack-web-api',

  async post(channelId, payload) {
    const result = await getWeb().chat.postMessage({
      channel: channelId,
      text: payload.text,
      blocks: payload.blocks as never,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!result.ok || !result.ts) throw new Error(`slack postMessage failed: ${result.error ?? 'unknown'}`);
    return { channelId: String(result.channel ?? channelId), messageTs: String(result.ts) };
  },

  async update(ref, payload) {
    const result = await getWeb().chat.update({
      channel: ref.channelId,
      ts: ref.messageTs,
      text: payload.text,
      blocks: payload.blocks as never,
    });
    if (!result.ok) throw new Error(`slack update failed: ${result.error ?? 'unknown'}`);
  },

  async postThreadReply(ref, payload) {
    const result = await getWeb().chat.postMessage({
      channel: ref.channelId,
      thread_ts: ref.messageTs,
      text: payload.text,
      ...(payload.blocks ? { blocks: payload.blocks as never } : {}),
      unfurl_links: false,
    });
    if (!result.ok || !result.ts) throw new Error(`slack thread reply failed: ${result.error ?? 'unknown'}`);
    return { channelId: String(result.channel ?? ref.channelId), messageTs: String(result.ts) };
  },

  async openModal(triggerId, view) {
    const result = await getWeb().views.open({ trigger_id: triggerId, view: view as never });
    if (!result.ok) throw new Error(`slack views.open failed: ${result.error ?? 'unknown'}`);
  },

  async lookupUser(userId) {
    try {
      const result = await getWeb().users.info({ user: userId });
      if (!result.ok || !result.user) return null;
      return {
        id: String(result.user.id),
        name: String(result.user.real_name ?? result.user.name ?? userId),
        email: (result.user.profile?.email as string | undefined) ?? null,
      };
    } catch (error) {
      log.warn('slack_user_lookup_failed', { error });
      return null;
    }
  },
};

/**
 * A transport that refuses to pretend. When Slack is not configured, posting
 * throws instead of silently succeeding: a demo that looks like it worked but
 * posted nothing is worse than a loud failure.
 */
export const unconfiguredTransport: SlackTransport = {
  name: 'slack-web-api',
  post() {
    throw new NotConfiguredError('Slack (SLACK_BOT_TOKEN or INTELLIGENCE_API_KEY)');
  },
  update() {
    throw new NotConfiguredError('Slack');
  },
  postThreadReply() {
    throw new NotConfiguredError('Slack');
  },
  openModal() {
    throw new NotConfiguredError('Slack');
  },
  async lookupUser() {
    return null;
  },
};

let override: SlackTransport | undefined;

/** Lets the gateway install the CopilotKit Channels transport at boot. */
export function setSlackTransport(transport: SlackTransport): void {
  override = transport;
  log.info('slack_transport_selected', { transport: transport.name });
}

export function slackTransport(): SlackTransport {
  if (override) return override;
  return isSlackWebApiConfigured() ? slackWebApiTransport : unconfiguredTransport;
}
