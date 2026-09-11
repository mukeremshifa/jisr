import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Rules from the brief, applied everywhere below:
 *  - UUID primary keys; a short *random* public_id for anything a human sees
 *  - company_id on every tenant table (the repository layer requires it)
 *  - timestamptz everywhere
 *  - money as integer fils, hours as integer hundredths, multipliers as basis points
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const now = () => ts('created_at').notNull().defaultNow();

export const caseStatusEnum = pgEnum('case_status', [
  'new',
  'clarifying',
  'awaiting_confirmation',
  'confirmed',
  'routed',
  'escalated',
  'in_progress',
  'decided',
  'closed',
  'reopened',
  'critical_open',
  'pending_supervisor',
  'pending_hr',
  'approved',
  'executed',
  'denied',
  'expired',
]);

export const caseCategoryEnum = pgEnum('case_category', [
  'maintenance',
  'pay',
  'safety',
  'accommodation',
  'leave',
  'transport',
  'other',
]);

export const caseSeverityEnum = pgEnum('case_severity', ['low', 'medium', 'high', 'critical']);
export const actorKindEnum = pgEnum('actor_kind', ['worker', 'staff', 'agent', 'system']);
export const directionEnum = pgEnum('message_direction', ['inbound', 'outbound']);
export const modalityEnum = pgEnum('message_modality', ['text', 'audio', 'image', 'location', 'sticker']);
export const mediaKindEnum = pgEnum('media_kind', ['image', 'audio_in', 'audio_out']);
export const assetKindEnum = pgEnum('asset_kind', ['room', 'bus', 'machine', 'gate', 'speakup']);
export const payStatusEnum = pgEnum('pay_status', [
  'proposed',
  'pending_supervisor',
  'pending_hr',
  'approved',
  'executed',
  'denied',
  'expired',
]);
export const payKindEnum = pgEnum('pay_kind', ['overtime', 'night_overtime', 'unpaid_days', 'other']);
export const broadcastStatusEnum = pgEnum('broadcast_status', [
  'draft',
  'previewed',
  'sending',
  'sent',
  'cancelled',
]);
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'queued',
  'sent',
  'delivered',
  'failed',
  'acked',
]);
export const auditSeverityEnum = pgEnum('audit_severity', ['info', 'warn', 'critical']);

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: now(),
});

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    radiusM: integer('radius_m'),
    slackChannelId: text('slack_channel_id'),
    /** Escalation and safety destinations, so routing is data rather than code. */
    slackEscalationChannelId: text('slack_escalation_channel_id'),
    slackSafetyChannelId: text('slack_safety_channel_id'),
    timezone: text('timezone').notNull().default('Asia/Dubai'),
    createdAt: now(),
  },
  (t) => [uniqueIndex('sites_company_code_uq').on(t.companyId, t.code)],
);

export const workers = pgTable(
  'workers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    siteId: uuid('site_id').references(() => sites.id),
    publicRef: text('public_ref').notNull(),
    displayName: text('display_name').notNull(),
    /** HMAC-SHA256(phone) with PHONE_HMAC_KEY. The only thing we look up by. */
    phoneHmac: text('phone_hmac').notNull(),
    /** AES-256-GCM(phone) with DATA_ENCRYPTION_KEY. Decrypted only to send a message. */
    phoneEnc: bytea('phone_enc').notNull(),
    language: text('language').notNull().default('en'),
    hourlyRateFils: integer('hourly_rate_fils').notNull().default(0),
    active: boolean('active').notNull().default(true),
    consentedAt: ts('consented_at'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('workers_phone_hmac_uq').on(t.phoneHmac),
    uniqueIndex('workers_company_ref_uq').on(t.companyId, t.publicRef),
  ],
);

export const staff = pgTable(
  'staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    email: text('email').notNull(),
    auth0Sub: text('auth0_sub'),
    slackUserId: text('slack_user_id'),
    displayName: text('display_name').notNull(),
    createdAt: now(),
    // Permissions live in FGA, not here. No role column on purpose.
  },
  (t) => [uniqueIndex('staff_company_email_uq').on(t.companyId, t.email)],
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    siteId: uuid('site_id').references(() => sites.id),
    code: text('code').notNull(),
    label: text('label').notNull(),
    kind: assetKindEnum('kind').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
  },
  (t) => [uniqueIndex('assets_company_code_uq').on(t.companyId, t.code)],
);

export const cases = pgTable(
  'cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    siteId: uuid('site_id').references(() => sites.id),
    assetId: uuid('asset_id').references(() => assets.id),
    /** NULL for speak-up cases. That is the whole point. */
    workerId: uuid('worker_id').references(() => workers.id),
    reporterTokenHash: text('reporter_token_hash'),
    isSpeakup: boolean('is_speakup').notNull().default(false),
    category: caseCategoryEnum('category'),
    severity: caseSeverityEnum('severity'),
    status: caseStatusEnum('status').notNull().default('new'),
    language: text('language').notNull().default('en'),
    summaryEn: text('summary_en'),
    transcriptOriginal: text('transcript_original'),
    transcriptEn: text('transcript_en'),
    confirmedByWorker: boolean('confirmed_by_worker').notNull().default(false),
    injectionSuspected: boolean('injection_suspected').notNull().default(false),
    /** Set when the model chain failed and a human must read the raw transcript. */
    needsReview: boolean('needs_review').notNull().default(false),
    clarifyCount: integer('clarify_count').notNull().default(0),
    correctionCount: integer('correction_count').notNull().default(0),
    /** Slack card coordinates, so updateCaseCard() can find the message again. */
    slackChannelId: text('slack_channel_id'),
    slackMessageTs: text('slack_message_ts'),
    /** Trigger.dev waitpoint token the manager decision completes. */
    decisionTokenId: text('decision_token_id'),
    slaDueAt: ts('sla_due_at'),
    firstResponseAt: ts('first_response_at'),
    routedAt: ts('routed_at'),
    createdAt: now(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    closedAt: ts('closed_at'),
  },
  (t) => [
    uniqueIndex('cases_public_id_uq').on(t.publicId),
    index('cases_company_status_idx').on(t.companyId, t.status),
    index('cases_site_idx').on(t.siteId),
    index('cases_worker_idx').on(t.workerId),
    index('cases_sla_idx').on(t.slaDueAt),
  ],
);

/**
 * F2. The only place a speak-up reporter's identity exists, encrypted under
 * SEALING_KEY - a different key from DATA_ENCRYPTION_KEY, so leaking one does
 * not unseal the other. Decrypted only by the relay task, only at send time.
 */
export const sealedIdentities = pgTable('sealed_identities', {
  caseId: uuid('case_id')
    .primaryKey()
    .references(() => cases.id),
  reporterWorkerIdEnc: bytea('reporter_worker_id_enc').notNull(),
  createdAt: now(),
});

export const caseEvents = pgTable(
  'case_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    type: text('type').notNull(),
    actorKind: actorKindEnum('actor_kind').notNull(),
    actorRef: text('actor_ref'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
  },
  (t) => [index('case_events_case_idx').on(t.caseId, t.createdAt)],
);

export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    gcsKey: text('gcs_key').notNull(),
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    kind: mediaKindEnum('kind').notNull(),
    /** Audio length in seconds, for the per-worker daily audio budget. */
    durationSeconds: integer('duration_seconds'),
    createdAt: now(),
  },
  (t) => [index('media_company_idx').on(t.companyId, t.createdAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    caseId: uuid('case_id').references(() => cases.id),
    /** NULL for speak-up, same reason as cases.worker_id. */
    workerId: uuid('worker_id').references(() => workers.id),
    direction: directionEnum('direction').notNull(),
    channel: text('channel').notNull().default('whatsapp'),
    modality: modalityEnum('modality').notNull(),
    /** Twilio MessageSid. Unique: this is our replay protection. */
    providerSid: text('provider_sid'),
    language: text('language'),
    textOriginal: text('text_original'),
    textEn: text('text_en'),
    mediaId: uuid('media_id').references(() => media.id),
    status: text('status').notNull().default('received'),
    /** Location pins, so F1 can match a site without a second round trip. */
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('messages_provider_sid_uq').on(t.providerSid),
    index('messages_case_idx').on(t.caseId, t.createdAt),
    index('messages_worker_idx').on(t.workerId, t.createdAt),
  ],
);

export const workerSessions = pgTable('worker_sessions', {
  workerId: uuid('worker_id')
    .primaryKey()
    .references(() => workers.id),
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id),
  pendingAssetId: uuid('pending_asset_id').references(() => assets.id),
  pendingAssetExpiresAt: ts('pending_asset_expires_at'),
  /** The clarifying question the worker is currently answering, in English. */
  pendingQuestion: text('pending_question'),
  pendingQuestionField: text('pending_question_field'),
  speakupCaseId: uuid('speakup_case_id').references(() => cases.id),
  lastCaseId: uuid('last_case_id').references(() => cases.id),
  /** Set while the worker is being asked to confirm speak-up mode. */
  speakupPending: boolean('speakup_pending').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const broadcasts = pgTable('broadcasts', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicId: text('public_id').notNull(),
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id),
  createdByStaffId: uuid('created_by_staff_id').references(() => staff.id),
  textEn: text('text_en').notNull(),
  /** { siteIds: string[] } - resolved at preview time, stored so Send cannot widen it. */
  target: jsonb('target').$type<{ siteIds: string[] }>().notNull().default({ siteIds: [] }),
  /** Per-language preview the human approved. Sending uses exactly these strings. */
  translations: jsonb('translations').$type<Array<{ language: string; text: string }>>().notNull().default([]),
  status: broadcastStatusEnum('status').notNull().default('draft'),
  slackChannelId: text('slack_channel_id'),
  slackMessageTs: text('slack_message_ts'),
  sentAt: ts('sent_at'),
  createdAt: now(),
});

export const broadcastDeliveries = pgTable(
  'broadcast_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    broadcastId: uuid('broadcast_id')
      .notNull()
      .references(() => broadcasts.id),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id),
    language: text('language').notNull(),
    providerSid: text('provider_sid'),
    status: deliveryStatusEnum('status').notNull().default('queued'),
    ackedAt: ts('acked_at'),
    remindersSent: integer('reminders_sent').notNull().default(0),
    createdAt: now(),
  },
  (t) => [uniqueIndex('broadcast_deliveries_uq').on(t.broadcastId, t.workerId)],
);

export const payAdjustments = pgTable(
  'pay_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id),
    /** YYYY-MM */
    period: text('period').notNull(),
    kind: payKindEnum('kind').notNull(),
    hoursX100: integer('hours_x100').notNull(),
    rateFils: integer('rate_fils').notNull(),
    multiplierBp: integer('multiplier_bp').notNull(),
    amountFils: integer('amount_fils').notNull(),
    /** SHA-256 of the canonical JSON. Binds approval to execution. */
    payloadSha256: text('payload_sha256').notNull(),
    status: payStatusEnum('status').notNull().default('proposed'),
    proposedByStaffId: uuid('proposed_by_staff_id').references(() => staff.id),
    approvedByStaffId: uuid('approved_by_staff_id').references(() => staff.id),
    /** Auth0 CIBA auth_req_id. */
    authReqId: text('auth_req_id'),
    decidedAt: ts('decided_at'),
    executedAt: ts('executed_at'),
    externalRef: text('external_ref'),
    createdAt: now(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('pay_company_status_idx').on(t.companyId, t.status)],
);

/** Insert-only for the app role (see migrations/0001_roles.sql). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id'),
    event: text('event').notNull(),
    severity: auditSeverityEnum('severity').notNull().default('info'),
    actor: text('actor'),
    subject: text('subject'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
  },
  (t) => [index('audit_company_time_idx').on(t.companyId, t.createdAt)],
);

export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: ts('window_start').notNull(),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export type Company = typeof companies.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type Worker = typeof workers.$inferSelect;
export type Staff = typeof staff.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
export type CaseEvent = typeof caseEvents.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type WorkerSession = typeof workerSessions.$inferSelect;
export type Broadcast = typeof broadcasts.$inferSelect;
export type BroadcastDelivery = typeof broadcastDeliveries.$inferSelect;
export type PayAdjustment = typeof payAdjustments.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
