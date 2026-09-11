import { escapeSlackText, filsToAed, hereMention, slackQuote, type CaseSeverity } from '@jisr/core';

/**
 * Block Kit builders. Every piece of worker- or model-supplied text goes through
 * `slackQuote`/`escapeSlackText` so it renders verbatim and cannot fire a mention
 * or disguise a link.
 */

export type Block = Record<string, unknown>;

const SEVERITY_DOT: Record<CaseSeverity, string> = {
  low: ':white_circle:',
  medium: ':large_yellow_circle:',
  high: ':large_orange_circle:',
  critical: ':red_circle:',
};

export interface ActionButton {
  /** Catalog action name; re-validated server-side on click. */
  action: string;
  label: string;
  params: Record<string, unknown>;
  style?: 'primary' | 'danger';
}

export interface CaseCardInput {
  casePublicId: string;
  caseId: string;
  companyId: string;
  category: string;
  severity: CaseSeverity;
  siteName: string | null;
  assetLabel: string | null;
  summaryEn: string;
  quoteOriginal: string | null;
  languageName: string;
  confirmedByWorker: boolean;
  unconfirmedBadge: boolean;
  injectionSuspected: boolean;
  needsReview: boolean;
  slaDueAt: Date | null;
  timezone: string;
  evidence: Array<{ url: string; kind: 'image' | 'audio_in' | 'audio_out'; alt: string }>;
  actions: ActionButton[];
  statusLine?: string;
  mentionHere?: boolean;
}

function formatTime(at: Date | null, timezone: string): string {
  if (!at) return 'not set';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(at);
}

export function buildCaseCard(input: CaseCardInput): { blocks: Block[]; text: string } {
  const location = [input.assetLabel, input.siteName].filter(Boolean).join(' (') + (input.assetLabel && input.siteName ? ')' : '');
  const header = [
    SEVERITY_DOT[input.severity],
    `*${escapeSlackText(titleCase(input.category))}*`,
    `· ${escapeSlackText(input.severity)}`,
    location ? `· ${escapeSlackText(location)}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const badges: string[] = [];
  if (input.unconfirmedBadge) badges.push(':grey_question: unconfirmed');
  if (input.injectionSuspected) badges.push(':shield: content flagged');
  if (input.needsReview) badges.push(':eyes: needs review');

  const blocks: Block[] = [];

  if (input.mentionHere) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: hereMention() } });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `${header}\n\`${escapeSlackText(input.casePublicId)}\`` },
  });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: slackQuote(input.summaryEn, 600) },
  });

  if (input.quoteOriginal) {
    const confirmed = input.confirmedByWorker ? ' — confirmed by worker' : '';
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `"${slackQuote(input.quoteOriginal, 240)}" (${escapeSlackText(input.languageName)})${confirmed}`,
        },
      ],
    });
  }

  if (badges.length > 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: badges.join('  ') }] });
  }

  for (const item of input.evidence) {
    if (item.kind === 'image') {
      blocks.push({
        type: 'image',
        image_url: item.url,
        alt_text: escapeSlackText(item.alt).slice(0, 150),
      });
    } else {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `<${item.url}|:sound: ${escapeSlackText(item.alt)}>` }],
      });
    }
  }

  if (input.actions.length > 0) {
    blocks.push({
      type: 'actions',
      block_id: `case_actions:${input.caseId}`,
      elements: input.actions
        .slice(0, 5)
        .map((button, index) => actionElement(button, index, input.caseId, input.companyId)),
    });
  }

  const footer = input.statusLine
    ? escapeSlackText(input.statusLine)
    : `First response due ${formatTime(input.slaDueAt, input.timezone)}`;
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] });

  return { blocks, text: `${input.casePublicId}: ${input.summaryEn}`.slice(0, 300) };
}

/**
 * A button that needs words from a human opens a modal instead of completing a
 * decision: the text has to exist before the action is valid, and a button
 * cannot carry text nobody has typed yet.
 */
const NEEDS_TEXT = new Set(['reply_freeform', 'ask_worker']);

function actionElement(
  button: ActionButton,
  index: number,
  caseId: string,
  companyId: string,
): Record<string, unknown> {
  const opensModal = NEEDS_TEXT.has(button.action) && !hasText(button.params);

  return {
    type: 'button',
    action_id: opensModal ? 'jisr_reply_freeform' : `jisr_case_action_${index}`,
    text: { type: 'plain_text', text: button.label.slice(0, 70), emoji: true },
    ...(button.style ? { style: button.style } : {}),
    value: JSON.stringify(
      opensModal
        ? { caseId, companyId }
        : { caseId, action: button.action, params: button.params },
    ).slice(0, 2000),
  };
}

function hasText(params: Record<string, unknown>): boolean {
  const text = params.text ?? params.question;
  return typeof text === 'string' && text.trim().length > 0;
}

/** F2. The speak-up card never shows a name, a number, or the original audio. */
export interface SpeakupCardInput {
  casePublicId: string;
  caseId: string;
  companyId: string;
  severity: CaseSeverity;
  summaryEnRedacted: string;
  revoicedAudioUrl: string | null;
  images: Array<{ url: string; alt: string }>;
  timezone: string;
  slaDueAt: Date | null;
}

export function buildSpeakupCard(input: SpeakupCardInput): { blocks: Block[]; text: string } {
  const blocks: Block[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${SEVERITY_DOT[input.severity]} *Speak-up report — identity sealed*\n\`${escapeSlackText(
          input.casePublicId,
        )}\``,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: slackQuote(input.summaryEnRedacted, 600) } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':lock: The reporter is hidden. Reply in this thread and I will relay your questions without revealing who they are.',
        },
      ],
    },
  ];

  if (input.revoicedAudioUrl) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `<${input.revoicedAudioUrl}|:sound: Re-voiced summary (synthetic voice)>` },
      ],
    });
  }

  for (const image of input.images) {
    blocks.push({ type: 'image', image_url: image.url, alt_text: escapeSlackText(image.alt).slice(0, 150) });
  }

  blocks.push({
    type: 'actions',
    block_id: `case_actions:${input.caseId}`,
    elements: [
      {
        // Opens a modal: the question is relayed to the sealed reporter, so it
        // has to be written before the action means anything.
        type: 'button',
        action_id: 'jisr_reply_freeform',
        text: { type: 'plain_text', text: 'Ask the reporter', emoji: true },
        value: JSON.stringify({ caseId: input.caseId, companyId: input.companyId }),
      },
      {
        type: 'button',
        action_id: 'jisr_case_action_1',
        text: { type: 'plain_text', text: 'Close report', emoji: true },
        value: JSON.stringify({ caseId: input.caseId, action: 'close', params: { note: '' } }),
      },
    ],
  });

  return { blocks, text: `Speak-up report ${input.casePublicId} — identity sealed` };
}

/** F3 step 1: the supervisor card. Amounts are server-computed and shown read-only. */
export interface PaySupervisorCardInput {
  casePublicId: string;
  caseId: string;
  adjustmentId: string;
  workerPublicRef: string;
  period: string;
  hoursX100: number;
  rateFils: number;
  multiplierBp: number;
  amountFils: number;
  evidence: Array<{ url: string; alt: string }>;
  statusLine?: string;
  decided?: boolean;
}

export function buildPaySupervisorCard(input: PaySupervisorCardInput): { blocks: Block[]; text: string } {
  const hours = (input.hoursX100 / 100).toFixed(2);
  const blocks: Block[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:money_with_wings: *Pay correction — step 1 of 2*\n\`${escapeSlackText(input.casePublicId)}\``,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Worker*\n${escapeSlackText(input.workerPublicRef)}` },
        { type: 'mrkdwn', text: `*Period*\n${escapeSlackText(input.period)}` },
        { type: 'mrkdwn', text: `*Hours*\n${hours}` },
        {
          type: 'mrkdwn',
          text: `*Amount*\nAED ${filsToAed(input.amountFils)}  _(${filsToAed(input.rateFils)}/h x ${(
            input.multiplierBp / 10000
          ).toFixed(2)})_`,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'The amount is calculated from the roster rate. Approving here sends it to HR for a second approval — you cannot approve both steps.',
        },
      ],
    },
  ];

  for (const item of input.evidence) {
    blocks.push({ type: 'image', image_url: item.url, alt_text: escapeSlackText(item.alt).slice(0, 150) });
  }

  if (!input.decided) {
    blocks.push({
      type: 'actions',
      block_id: `pay_actions:${input.adjustmentId}`,
      elements: [
        {
          type: 'button',
          action_id: 'jisr_case_action_0',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve correction', emoji: true },
          value: JSON.stringify({ caseId: input.caseId, action: 'approve_pay_step1', params: {} }),
        },
        {
          type: 'button',
          action_id: 'jisr_pay_edit_hours',
          text: { type: 'plain_text', text: 'Edit hours', emoji: true },
          value: JSON.stringify({ caseId: input.caseId, adjustmentId: input.adjustmentId }),
        },
        {
          type: 'button',
          action_id: 'jisr_case_action_2',
          text: { type: 'plain_text', text: 'Ask for evidence', emoji: true },
          value: JSON.stringify({ caseId: input.caseId, action: 'ask_evidence', params: {} }),
        },
        {
          type: 'button',
          action_id: 'jisr_pay_reject',
          style: 'danger',
          text: { type: 'plain_text', text: 'Reject', emoji: true },
          value: JSON.stringify({ caseId: input.caseId, adjustmentId: input.adjustmentId }),
        },
      ],
    });
  }

  if (input.statusLine) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlackText(input.statusLine) }] });
  }

  return { blocks, text: `Pay correction ${input.casePublicId}: AED ${filsToAed(input.amountFils)}` };
}

/** F3 step 2: the HR thread card. HR approves on their phone, never on this card. */
export function buildPayHrCard(input: {
  casePublicId: string;
  approverName: string;
  amountFils: number;
  hoursX100: number;
  workerPublicRef: string;
  period: string;
  payloadSha256: string;
  statusLine: string;
}): { blocks: Block[]; text: string } {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:lock: *Pay correction — step 2 of 2*\n\`${escapeSlackText(input.casePublicId)}\``,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Worker*\n${escapeSlackText(input.workerPublicRef)}` },
          { type: 'mrkdwn', text: `*Period*\n${escapeSlackText(input.period)}` },
          { type: 'mrkdwn', text: `*Hours*\n${(input.hoursX100 / 100).toFixed(2)}` },
          { type: 'mrkdwn', text: `*Amount*\nAED ${filsToAed(input.amountFils)}` },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: escapeSlackText(input.statusLine) },
          { type: 'mrkdwn', text: `approval hash \`${escapeSlackText(input.payloadSha256.slice(0, 12))}\`` },
        ],
      },
    ],
    text: `Pay correction ${input.casePublicId}: waiting for ${input.approverName}`,
  };
}

/** C4: the live acknowledgement card. Updated in place as acks arrive. */
export function buildBroadcastAckCard(input: {
  broadcastPublicId: string;
  textEn: string;
  total: number;
  acked: number;
  languages: string[];
  pending: string[];
  status: string;
}): { blocks: Block[]; text: string } {
  const blocks: Block[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:mega: *Broadcast* \`${escapeSlackText(input.broadcastPublicId)}\`\n${slackQuote(input.textEn, 400)}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Heard it*\n${input.acked} of ${input.total}` },
        { type: 'mrkdwn', text: `*Languages*\n${escapeSlackText(input.languages.join(', '))}` },
      ],
    },
  ];

  if (input.pending.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Waiting on: ${escapeSlackText(input.pending.slice(0, 20).join(', '))}${
            input.pending.length > 20 ? ` +${input.pending.length - 20} more` : ''
          }`,
        },
      ],
    });
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlackText(input.status) }] });
  return { blocks, text: `Broadcast ${input.broadcastPublicId}: ${input.acked}/${input.total} acknowledged` };
}

/** The broadcast preview. Nothing goes out until a human clicks Send. */
export function buildBroadcastPreview(input: {
  broadcastId: string;
  textEn: string;
  translations: Array<{ languageName: string; text: string }>;
  recipientCount: number;
  siteNames: string[];
}): { blocks: Block[]; text: string } {
  const blocks: Block[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:mega: *Broadcast preview* — ${input.recipientCount} worker(s) at ${escapeSlackText(
          input.siteNames.join(', ') || 'no site',
        )}`,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*English*\n${slackQuote(input.textEn, 400)}` } },
  ];

  for (const t of input.translations) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escapeSlackText(t.languageName)}*\n${slackQuote(t.text, 400)}` },
    });
  }

  blocks.push({
    type: 'actions',
    block_id: `broadcast_actions:${input.broadcastId}`,
    elements: [
      {
        type: 'button',
        action_id: 'jisr_broadcast_send',
        style: 'primary',
        text: { type: 'plain_text', text: `Send to ${input.recipientCount}`, emoji: true },
        value: JSON.stringify({ broadcastId: input.broadcastId }),
      },
      {
        type: 'button',
        action_id: 'jisr_broadcast_cancel',
        text: { type: 'plain_text', text: 'Cancel', emoji: true },
        value: JSON.stringify({ broadcastId: input.broadcastId }),
      },
    ],
  });

  return { blocks, text: 'Broadcast preview — nothing has been sent yet' };
}

/** The "Reply in my own words" modal, and the validated hours modal for F3. */
export function buildReplyModal(
  caseId: string,
  casePublicId: string,
  companyId: string,
): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: 'jisr_reply_modal',
    // A view_submission carries no channel or message, so the tenant travels
    // with the modal rather than being guessed at submit time.
    private_metadata: JSON.stringify({ caseId, companyId }),
    title: { type: 'plain_text', text: 'Reply to worker' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'reply',
        label: { type: 'plain_text', text: `Your reply for ${casePublicId}` },
        element: {
          type: 'plain_text_input',
          action_id: 'text',
          multiline: true,
          max_length: 600,
          placeholder: { type: 'plain_text', text: 'I will send a technician this afternoon.' },
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'I will translate this and send it to the worker as a voice note plus text.',
          },
        ],
      },
    ],
  };
}

export function buildEditHoursModal(input: {
  adjustmentId: string;
  caseId: string;
  companyId: string;
  currentHoursX100: number;
}): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: 'jisr_edit_hours_modal',
    private_metadata: JSON.stringify({
      adjustmentId: input.adjustmentId,
      caseId: input.caseId,
      companyId: input.companyId,
    }),
    title: { type: 'plain_text', text: 'Edit hours' },
    submit: { type: 'plain_text', text: 'Recalculate' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'hours',
        label: { type: 'plain_text', text: 'Hours (more than 0, at most 60)' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          initial_value: (input.currentHoursX100 / 100).toFixed(2),
          max_length: 6,
        },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'The amount is recalculated on the server from the roster rate.' },
        ],
      },
    ],
  };
}

export function buildRejectModal(input: {
  adjustmentId: string;
  caseId: string;
  companyId: string;
}): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: 'jisr_reject_pay_modal',
    private_metadata: JSON.stringify({
      adjustmentId: input.adjustmentId,
      caseId: input.caseId,
      companyId: input.companyId,
    }),
    title: { type: 'plain_text', text: 'Reject correction' },
    submit: { type: 'plain_text', text: 'Reject' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'reason',
        label: { type: 'plain_text', text: 'Reason (the worker hears a gentler version of this)' },
        element: { type: 'plain_text_input', action_id: 'text', multiline: true, max_length: 300 },
      },
    ],
  };
}

function titleCase(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1).replace(/_/g, ' ');
}
