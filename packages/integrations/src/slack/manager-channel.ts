import {
  config,
  features,
  languageOf,
  log,
  type CaseSeverity,
  type CaseCategory,
} from '@jisr/core';
import { repo, withTenant, audit, type Case } from '@jisr/db';
import { signedUrl } from '../gcs';
import {
  buildBroadcastAckCard,
  buildCaseCard,
  buildPayHrCard,
  buildPaySupervisorCard,
  buildSpeakupCard,
  type ActionButton,
} from './blocks';
import { slackTransport, type MessageRef } from './transport';

/**
 * The only two ways a case reaches Slack.
 *
 * Everything about *where* a case goes is decided here, from site data, not from
 * anything a model produced:
 *   - normal cases  -> the site channel
 *   - critical      -> the site channel with @here, and the safety channel
 *   - speak-up      -> the HR speak-up channel only, never the site channel
 *   - pay           -> the site channel first (F3 step 1)
 */

export interface NotifyOptions {
  /** Allowlisted actions the model suggested; re-validated before they run. */
  actions?: ActionButton[];
  /** Speak-up cards are built from redacted data and posted to HR only. */
  speakup?: { summaryEnRedacted: string; revoicedMediaId: string | null; imageMediaIds: string[] };
  /** Channel override, used by the escalation path. */
  channelId?: string;
  mentionHere?: boolean;
  statusLine?: string;
}

function severityOf(row: Case): CaseSeverity {
  return (row.severity ?? 'medium') as CaseSeverity;
}

async function evidenceFor(
  companyId: string,
  caseId: string,
): Promise<Array<{ url: string; kind: 'image' | 'audio_in' | 'audio_out'; alt: string }>> {
  return withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const rows = await r.messagesForCase(caseId);
    const out: Array<{ url: string; kind: 'image' | 'audio_in' | 'audio_out'; alt: string }> = [];
    for (const message of rows) {
      if (!message.mediaId || message.direction !== 'inbound') continue;
      const item = await r.mediaById(message.mediaId);
      if (!item) continue;
      try {
        out.push({
          url: await signedUrl(item.gcsKey, 'dashboard'),
          kind: item.kind,
          alt: item.kind === 'image' ? 'Photo from the worker' : 'Voice note from the worker',
        });
      } catch (error) {
        // A missing signed URL must not take the card down.
        log.warn('evidence_url_failed', { mediaId: item.id, error });
      }
    }
    return out.slice(0, 4);
  });
}

/**
 * Entry point 1. Posts a case to the right Slack destination and records where
 * the card landed so `updateCaseCard` can find it again.
 */
export async function notifyManagers(
  companyId: string,
  caseId: string,
  options: NotifyOptions = {},
): Promise<MessageRef | null> {
  const transport = slackTransport();

  const loaded = await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const row = await r.caseById(caseId);
    if (!row) return null;
    const site = row.siteId ? await r.siteById(row.siteId) : null;
    const asset = row.assetId ? await r.assetById(row.assetId) : null;
    const company = await r.company();
    return { row, site, asset, companyName: company?.name ?? 'the company' };
  });

  if (!loaded) {
    log.warn('notify_managers_case_missing', { caseId });
    return null;
  }
  const { row, site, asset } = loaded;

  // ------------------------------------------------------------- speak-up (F2)
  if (row.isSpeakup) {
    if (!features.speakup) return null;
    const channelId = options.channelId ?? config.SLACK_SPEAKUP_CHANNEL_ID;
    if (!channelId) {
      log.error('speakup_channel_missing', { caseId: row.id });
      return null;
    }
    const speakup = options.speakup;
    const card = buildSpeakupCard({
      casePublicId: row.publicId,
      caseId: row.id,
      companyId,
      severity: severityOf(row),
      summaryEnRedacted: speakup?.summaryEnRedacted ?? row.summaryEn ?? '(no summary)',
      revoicedAudioUrl: speakup?.revoicedMediaId
        ? await signedUrlForMedia(companyId, speakup.revoicedMediaId)
        : null,
      images: await imagesForMedia(companyId, speakup?.imageMediaIds ?? []),
      timezone: site?.timezone ?? 'Asia/Dubai',
      slaDueAt: row.slaDueAt,
    });
    const ref = await transport.post(channelId, card);
    await persistRef(companyId, row.id, ref);
    return ref;
  }

  // ------------------------------------------------------------- normal cases
  const channelId = options.channelId ?? site?.slackChannelId ?? config.SLACK_DEFAULT_CHANNEL_ID;
  if (!channelId) {
    log.error('case_channel_missing', { caseId: row.id, siteId: row.siteId });
    return null;
  }

  const isCritical = severityOf(row) === 'critical' || row.status === 'critical_open';
  const card = buildCaseCard({
    casePublicId: row.publicId,
    caseId: row.id,
    companyId,
    category: (row.category ?? 'other') as CaseCategory,
    severity: severityOf(row),
    siteName: site?.name ?? null,
    assetLabel: asset?.label ?? null,
    summaryEn: row.summaryEn ?? '(no summary yet)',
    quoteOriginal: row.transcriptOriginal,
    languageName: languageOf(row.language).name,
    confirmedByWorker: row.confirmedByWorker,
    unconfirmedBadge: !row.confirmedByWorker,
    injectionSuspected: row.injectionSuspected,
    needsReview: row.needsReview,
    slaDueAt: row.slaDueAt,
    timezone: site?.timezone ?? 'Asia/Dubai',
    evidence: await evidenceFor(companyId, row.id),
    actions: options.actions ?? [],
    mentionHere: options.mentionHere ?? isCritical,
    ...(options.statusLine ? { statusLine: options.statusLine } : {}),
  });

  const ref = await transport.post(channelId, card);
  await persistRef(companyId, row.id, ref);

  // Critical cases are also mirrored to the safety channel. That copy is a
  // notification, not the card of record, so its ref is not stored.
  const safetyChannel = site?.slackSafetyChannelId ?? config.SLACK_SAFETY_CHANNEL_ID;
  if (isCritical && safetyChannel && safetyChannel !== channelId) {
    await transport.post(safetyChannel, card).catch((error: unknown) => {
      log.warn('safety_channel_post_failed', { error });
      return null;
    });
  }

  return ref;
}

/** Entry point 2. Re-renders the card in place after a decision or a state change. */
export async function updateCaseCard(
  companyId: string,
  caseId: string,
  options: NotifyOptions = {},
): Promise<void> {
  const loaded = await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const row = await r.caseById(caseId);
    if (!row) return null;
    const site = row.siteId ? await r.siteById(row.siteId) : null;
    const asset = row.assetId ? await r.assetById(row.assetId) : null;
    return { row, site, asset };
  });
  if (!loaded?.row.slackChannelId || !loaded.row.slackMessageTs) return;

  const { row, site, asset } = loaded;
  const ref: MessageRef = { channelId: row.slackChannelId!, messageTs: row.slackMessageTs! };

  const card = row.isSpeakup
    ? buildSpeakupCard({
        casePublicId: row.publicId,
        caseId: row.id,
        companyId,
        severity: severityOf(row),
        summaryEnRedacted: row.summaryEn ?? '',
        revoicedAudioUrl: null,
        images: [],
        timezone: site?.timezone ?? 'Asia/Dubai',
        slaDueAt: row.slaDueAt,
      })
    : buildCaseCard({
        casePublicId: row.publicId,
        caseId: row.id,
        companyId,
        category: (row.category ?? 'other') as CaseCategory,
        severity: severityOf(row),
        siteName: site?.name ?? null,
        assetLabel: asset?.label ?? null,
        summaryEn: row.summaryEn ?? '',
        quoteOriginal: row.transcriptOriginal,
        languageName: languageOf(row.language).name,
        confirmedByWorker: row.confirmedByWorker,
        unconfirmedBadge: !row.confirmedByWorker,
        injectionSuspected: row.injectionSuspected,
        needsReview: row.needsReview,
        slaDueAt: row.slaDueAt,
        timezone: site?.timezone ?? 'Asia/Dubai',
        evidence: await evidenceFor(companyId, row.id),
        actions: options.actions ?? [],
        statusLine: options.statusLine ?? statusLineFor(row),
      });

  await slackTransport().update(ref, card);
}

function statusLineFor(row: Case): string {
  switch (row.status) {
    case 'escalated':
      return 'Past SLA — escalated to a senior manager';
    case 'decided':
      return 'Decision sent to the worker';
    case 'closed':
      return 'Closed';
    case 'in_progress':
      return 'In progress';
    case 'pending_hr':
      return 'Waiting for HR approval';
    case 'executed':
      return 'Correction executed';
    case 'denied':
      return 'Rejected';
    default:
      return `Status: ${row.status}`;
  }
}

async function persistRef(companyId: string, caseId: string, ref: MessageRef): Promise<void> {
  await withTenant(companyId, async ({ tx }) => {
    await repo(companyId, tx).updateCase(caseId, {
      slackChannelId: ref.channelId,
      slackMessageTs: ref.messageTs,
    });
  });
}

async function signedUrlForMedia(companyId: string, mediaId: string): Promise<string | null> {
  return withTenant(companyId, async ({ tx }) => {
    const item = await repo(companyId, tx).mediaById(mediaId);
    if (!item) return null;
    return signedUrl(item.gcsKey, 'dashboard').catch(() => null);
  });
}

async function imagesForMedia(
  companyId: string,
  mediaIds: string[],
): Promise<Array<{ url: string; alt: string }>> {
  const out: Array<{ url: string; alt: string }> = [];
  for (const id of mediaIds.slice(0, 4)) {
    const url = await signedUrlForMedia(companyId, id);
    if (url) out.push({ url, alt: 'Photo from the reporter (metadata removed)' });
  }
  return out;
}

/** Thread replies: decision notes, escalation notices, HR speak-up follow-ups. */
export async function postThreadNote(
  companyId: string,
  caseId: string,
  text: string,
): Promise<void> {
  const row = await withTenant(companyId, ({ tx }) => repo(companyId, tx).caseById(caseId));
  if (!row?.slackChannelId || !row.slackMessageTs) return;
  await slackTransport().postThreadReply(
    { channelId: row.slackChannelId, messageTs: row.slackMessageTs },
    { text },
  );
}

/** C2 SLA: the escalation post goes to the site's escalation channel. */
export async function postEscalation(companyId: string, caseId: string): Promise<void> {
  const loaded = await withTenant(companyId, async ({ tx }) => {
    const r = repo(companyId, tx);
    const row = await r.caseById(caseId);
    const site = row?.siteId ? await r.siteById(row.siteId) : null;
    return { row, site };
  });
  if (!loaded.row) return;

  const channelId =
    loaded.site?.slackEscalationChannelId ?? config.SLACK_ESCALATION_CHANNEL_ID ?? loaded.site?.slackChannelId;
  if (!channelId) {
    log.warn('escalation_channel_missing', { caseId });
    return;
  }

  await notifyManagers(companyId, caseId, {
    channelId,
    mentionHere: true,
    statusLine: 'Past SLA with no first response — escalated',
  });

  await withTenant(companyId, ({ tx }) =>
    audit({ event: 'case_escalated', companyId, subject: loaded.row!.publicId, severity: 'warn' }, tx),
  );
}

export { buildBroadcastAckCard, buildPayHrCard, buildPaySupervisorCard };
