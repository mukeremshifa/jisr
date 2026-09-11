import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  newCasePublicId,
  randomCode,
  type CaseStatus,
  type CaseCategory,
  type CaseSeverity,
  assertTransition,
} from '@jisr/core';
import { getDb, type DbOrTx } from './client';
import {
  assets,
  auditLog,
  broadcastDeliveries,
  broadcasts,
  caseEvents,
  cases,
  companies,
  media,
  messages,
  payAdjustments,
  rateLimits,
  sealedIdentities,
  sites,
  staff,
  workerSessions,
  workers,
  type Asset,
  type Case,
  type NewCase,
  type Site,
  type Worker,
} from './schema';

/**
 * The tenant-scoped repository. Every function here takes `companyId` and filters
 * on it. There is no unscoped read of a tenant table anywhere else in the codebase.
 */
export function repo(companyId: string, tx: DbOrTx = getDb()) {
  const owned = <T extends { companyId: unknown }>(table: T) => eq(table.companyId as never, companyId);

  return {
    companyId,
    tx,

    // ---------------------------------------------------------------- company
    async company() {
      const [row] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
      return row ?? null;
    },

    // ------------------------------------------------------------------ sites
    async sites(): Promise<Site[]> {
      return tx.select().from(sites).where(owned(sites)).orderBy(asc(sites.code));
    },

    async siteById(siteId: string): Promise<Site | null> {
      const [row] = await tx
        .select()
        .from(sites)
        .where(and(owned(sites), eq(sites.id, siteId)))
        .limit(1);
      return row ?? null;
    },

    async siteByCode(code: string): Promise<Site | null> {
      const [row] = await tx
        .select()
        .from(sites)
        .where(and(owned(sites), eq(sites.code, code)))
        .limit(1);
      return row ?? null;
    },

    async siteBySlackChannel(channelId: string): Promise<Site | null> {
      const [row] = await tx
        .select()
        .from(sites)
        .where(and(owned(sites), eq(sites.slackChannelId, channelId)))
        .limit(1);
      return row ?? null;
    },

    // ---------------------------------------------------------------- workers
    async workerById(workerId: string): Promise<Worker | null> {
      const [row] = await tx
        .select()
        .from(workers)
        .where(and(owned(workers), eq(workers.id, workerId)))
        .limit(1);
      return row ?? null;
    },

    async activeWorkersForSites(siteIds: string[]): Promise<Worker[]> {
      if (siteIds.length === 0) return [];
      return tx
        .select()
        .from(workers)
        .where(and(owned(workers), eq(workers.active, true), inArray(workers.siteId, siteIds)));
    },

    async markConsented(workerId: string): Promise<void> {
      await tx
        .update(workers)
        .set({ consentedAt: new Date() })
        .where(and(owned(workers), eq(workers.id, workerId), isNull(workers.consentedAt)));
    },

    // ------------------------------------------------------------------ staff
    async staffById(staffId: string) {
      const [row] = await tx
        .select()
        .from(staff)
        .where(and(owned(staff), eq(staff.id, staffId)))
        .limit(1);
      return row ?? null;
    },

    async staffBySlackUserId(slackUserId: string) {
      const [row] = await tx
        .select()
        .from(staff)
        .where(and(owned(staff), eq(staff.slackUserId, slackUserId)))
        .limit(1);
      return row ?? null;
    },

    async staffByAuth0Sub(sub: string) {
      const [row] = await tx
        .select()
        .from(staff)
        .where(and(owned(staff), eq(staff.auth0Sub, sub)))
        .limit(1);
      return row ?? null;
    },

    async allStaff() {
      return tx.select().from(staff).where(owned(staff)).orderBy(asc(staff.displayName));
    },

    // ----------------------------------------------------------------- assets
    async assetByCode(code: string): Promise<Asset | null> {
      const [row] = await tx
        .select()
        .from(assets)
        .where(and(owned(assets), eq(assets.code, code.toUpperCase())))
        .limit(1);
      return row ?? null;
    },

    async assetById(assetId: string): Promise<Asset | null> {
      const [row] = await tx
        .select()
        .from(assets)
        .where(and(owned(assets), eq(assets.id, assetId)))
        .limit(1);
      return row ?? null;
    },

    async allAssets(): Promise<Asset[]> {
      return tx.select().from(assets).where(owned(assets)).orderBy(asc(assets.code));
    },

    // --------------------------------------------------------- worker session
    async session(workerId: string) {
      const [row] = await tx
        .select()
        .from(workerSessions)
        .where(and(owned(workerSessions), eq(workerSessions.workerId, workerId)))
        .limit(1);
      return row ?? null;
    },

    async upsertSession(workerId: string, patch: Partial<typeof workerSessions.$inferInsert>) {
      const values = { workerId, companyId, ...patch, updatedAt: new Date() };
      const [row] = await tx
        .insert(workerSessions)
        .values(values)
        .onConflictDoUpdate({
          target: workerSessions.workerId,
          set: { ...patch, updatedAt: new Date() },
        })
        .returning();
      return row!;
    },

    // ------------------------------------------------------------------ cases
    async createCase(input: Omit<NewCase, 'id' | 'companyId' | 'publicId'>): Promise<Case> {
      const [row] = await tx
        .insert(cases)
        .values({ ...input, companyId, publicId: newCasePublicId() })
        .returning();
      return row!;
    },

    async caseById(caseId: string): Promise<Case | null> {
      const [row] = await tx
        .select()
        .from(cases)
        .where(and(owned(cases), eq(cases.id, caseId)))
        .limit(1);
      return row ?? null;
    },

    async caseByPublicId(publicId: string): Promise<Case | null> {
      const [row] = await tx
        .select()
        .from(cases)
        .where(and(owned(cases), eq(cases.publicId, publicId.toUpperCase())))
        .limit(1);
      return row ?? null;
    },

    async updateCase(caseId: string, patch: Partial<NewCase>): Promise<Case> {
      const [row] = await tx
        .update(cases)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(owned(cases), eq(cases.id, caseId)))
        .returning();
      if (!row) throw new Error(`case ${caseId} not found in company ${companyId}`);
      return row;
    },

    /** Status changes go through the state machine, never through updateCase directly. */
    async transitionCase(caseId: string, to: CaseStatus, patch: Partial<NewCase> = {}): Promise<Case> {
      const current = await this.caseById(caseId);
      if (!current) throw new Error(`case ${caseId} not found`);
      assertTransition(current.status as CaseStatus, to);
      const extra: Partial<NewCase> = to === 'closed' ? { closedAt: new Date() } : {};
      return this.updateCase(caseId, { ...patch, ...extra, status: to });
    },

    async openCases(filters: {
      siteIds?: string[];
      statuses?: CaseStatus[];
      category?: CaseCategory;
      severity?: CaseSeverity;
      includeSpeakup?: boolean;
      limit?: number;
    } = {}): Promise<Case[]> {
      const clauses = [owned(cases)];
      if (filters.siteIds?.length) clauses.push(inArray(cases.siteId, filters.siteIds));
      if (filters.statuses?.length) clauses.push(inArray(cases.status, filters.statuses));
      if (filters.category) clauses.push(eq(cases.category, filters.category));
      if (filters.severity) clauses.push(eq(cases.severity, filters.severity));
      if (!filters.includeSpeakup) clauses.push(eq(cases.isSpeakup, false));
      return tx
        .select()
        .from(cases)
        .where(and(...clauses))
        .orderBy(desc(cases.createdAt))
        .limit(Math.min(filters.limit ?? 50, 200));
    },

    /** Cases whose SLA has passed and which nobody has answered yet. */
    async casesPastSla(now: Date = new Date()): Promise<Case[]> {
      return tx
        .select()
        .from(cases)
        .where(
          and(
            owned(cases),
            lt(cases.slaDueAt, now),
            isNull(cases.firstResponseAt),
            inArray(cases.status, ['routed', 'in_progress', 'critical_open', 'reopened']),
          ),
        )
        .orderBy(asc(cases.slaDueAt));
    },

    async recentCaseForWorker(workerId: string): Promise<Case | null> {
      const [row] = await tx
        .select()
        .from(cases)
        .where(and(owned(cases), eq(cases.workerId, workerId)))
        .orderBy(desc(cases.createdAt))
        .limit(1);
      return row ?? null;
    },

    // ----------------------------------------------------------- case events
    async addEvent(input: {
      caseId: string;
      type: string;
      actorKind: 'worker' | 'staff' | 'agent' | 'system';
      actorRef?: string | null;
      payload?: Record<string, unknown>;
    }) {
      const [row] = await tx
        .insert(caseEvents)
        .values({
          companyId,
          caseId: input.caseId,
          type: input.type,
          actorKind: input.actorKind,
          actorRef: input.actorRef ?? null,
          payload: input.payload ?? {},
        })
        .returning();
      return row!;
    },

    async caseTimeline(caseId: string) {
      return tx
        .select()
        .from(caseEvents)
        .where(and(owned(caseEvents), eq(caseEvents.caseId, caseId)))
        .orderBy(asc(caseEvents.createdAt));
    },

    // --------------------------------------------------------------- messages
    async insertMessage(input: Omit<typeof messages.$inferInsert, 'companyId'>) {
      const [row] = await tx
        .insert(messages)
        .values({ ...input, companyId })
        .onConflictDoNothing({ target: messages.providerSid })
        .returning();
      return row ?? null;
    },

    async messageById(messageId: string) {
      const [row] = await tx
        .select()
        .from(messages)
        .where(and(owned(messages), eq(messages.id, messageId)))
        .limit(1);
      return row ?? null;
    },

    async messagesForCase(caseId: string) {
      return tx
        .select()
        .from(messages)
        .where(and(owned(messages), eq(messages.caseId, caseId)))
        .orderBy(asc(messages.createdAt));
    },

    async updateMessage(messageId: string, patch: Partial<typeof messages.$inferInsert>) {
      await tx
        .update(messages)
        .set(patch)
        .where(and(owned(messages), eq(messages.id, messageId)));
    },

    async messageByProviderSid(sid: string) {
      const [row] = await tx
        .select()
        .from(messages)
        .where(and(owned(messages), eq(messages.providerSid, sid)))
        .limit(1);
      return row ?? null;
    },

    // ------------------------------------------------------------------ media
    async insertMedia(input: Omit<typeof media.$inferInsert, 'companyId'>) {
      const [row] = await tx
        .insert(media)
        .values({ ...input, companyId })
        .returning();
      return row!;
    },

    async mediaById(mediaId: string) {
      const [row] = await tx
        .select()
        .from(media)
        .where(and(owned(media), eq(media.id, mediaId)))
        .limit(1);
      return row ?? null;
    },

    // ------------------------------------------------------- sealed identity
    /**
     * F2. Write-only from the app's point of view: `unsealIdentity` exists, but
     * only the relay task calls it, and only to address an outbound message.
     */
    async sealIdentity(caseId: string, reporterWorkerIdEnc: Buffer) {
      await tx.insert(sealedIdentities).values({ caseId, reporterWorkerIdEnc }).onConflictDoNothing();
    },

    async sealedIdentity(caseId: string) {
      const [row] = await tx
        .select()
        .from(sealedIdentities)
        .where(eq(sealedIdentities.caseId, caseId))
        .limit(1);
      return row ?? null;
    },

    // ------------------------------------------------------------- broadcasts
    async createBroadcast(input: {
      createdByStaffId: string | null;
      textEn: string;
      siteIds: string[];
      translations: Array<{ language: string; text: string }>;
    }) {
      const [row] = await tx
        .insert(broadcasts)
        .values({
          companyId,
          publicId: `BC-${randomCode(4)}`,
          createdByStaffId: input.createdByStaffId,
          textEn: input.textEn,
          target: { siteIds: input.siteIds },
          translations: input.translations,
          status: 'previewed',
        })
        .returning();
      return row!;
    },

    async recentBroadcasts(limit = 20) {
      return tx
        .select()
        .from(broadcasts)
        .where(owned(broadcasts))
        .orderBy(desc(broadcasts.createdAt))
        .limit(Math.min(limit, 100));
    },

    async broadcastById(broadcastId: string) {
      const [row] = await tx
        .select()
        .from(broadcasts)
        .where(and(owned(broadcasts), eq(broadcasts.id, broadcastId)))
        .limit(1);
      return row ?? null;
    },

    async updateBroadcast(broadcastId: string, patch: Partial<typeof broadcasts.$inferInsert>) {
      const [row] = await tx
        .update(broadcasts)
        .set(patch)
        .where(and(owned(broadcasts), eq(broadcasts.id, broadcastId)))
        .returning();
      return row ?? null;
    },

    async createDelivery(input: { broadcastId: string; workerId: string; language: string }) {
      const [row] = await tx
        .insert(broadcastDeliveries)
        .values({ ...input, companyId })
        .onConflictDoNothing({ target: [broadcastDeliveries.broadcastId, broadcastDeliveries.workerId] })
        .returning();
      return row ?? null;
    },

    async updateDelivery(
      broadcastId: string,
      workerId: string,
      patch: Partial<typeof broadcastDeliveries.$inferInsert>,
    ) {
      const [row] = await tx
        .update(broadcastDeliveries)
        .set(patch)
        .where(
          and(
            owned(broadcastDeliveries),
            eq(broadcastDeliveries.broadcastId, broadcastId),
            eq(broadcastDeliveries.workerId, workerId),
          ),
        )
        .returning();
      return row ?? null;
    },

    async deliveries(broadcastId: string) {
      return tx
        .select()
        .from(broadcastDeliveries)
        .where(and(owned(broadcastDeliveries), eq(broadcastDeliveries.broadcastId, broadcastId)));
    },

    /** The most recent broadcast a worker could plausibly be acknowledging (24h window). */
    async pendingAckForWorker(workerId: string, now: Date = new Date()) {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const [row] = await tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            owned(broadcastDeliveries),
            eq(broadcastDeliveries.workerId, workerId),
            isNull(broadcastDeliveries.ackedAt),
            gte(broadcastDeliveries.createdAt, since),
            inArray(broadcastDeliveries.status, ['sent', 'delivered', 'queued']),
          ),
        )
        .orderBy(desc(broadcastDeliveries.createdAt))
        .limit(1);
      return row ?? null;
    },

    // -------------------------------------------------------- pay adjustments
    async createPayAdjustment(input: Omit<typeof payAdjustments.$inferInsert, 'companyId'>) {
      const [row] = await tx
        .insert(payAdjustments)
        .values({ ...input, companyId })
        .returning();
      return row!;
    },

    async payAdjustmentById(id: string) {
      const [row] = await tx
        .select()
        .from(payAdjustments)
        .where(and(owned(payAdjustments), eq(payAdjustments.id, id)))
        .limit(1);
      return row ?? null;
    },

    async payAdjustmentByCase(caseId: string) {
      const [row] = await tx
        .select()
        .from(payAdjustments)
        .where(and(owned(payAdjustments), eq(payAdjustments.caseId, caseId)))
        .orderBy(desc(payAdjustments.createdAt))
        .limit(1);
      return row ?? null;
    },

    async updatePayAdjustment(id: string, patch: Partial<typeof payAdjustments.$inferInsert>) {
      const [row] = await tx
        .update(payAdjustments)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(owned(payAdjustments), eq(payAdjustments.id, id)))
        .returning();
      if (!row) throw new Error(`pay adjustment ${id} not found`);
      return row;
    },

    async payQueue(limit = 50) {
      return tx
        .select()
        .from(payAdjustments)
        .where(owned(payAdjustments))
        .orderBy(desc(payAdjustments.createdAt))
        .limit(limit);
    },

    // ------------------------------------------------------------- audit log
    async auditEntries(limit = 100) {
      return tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId))
        .orderBy(desc(auditLog.createdAt))
        .limit(Math.min(limit, 500));
    },
  };
}

export type Repo = ReturnType<typeof repo>;

/**
 * Rate limiting is deliberately outside the tenant repository: the unknown-sender
 * limiter must work before we know which company (or whether) a number belongs to.
 * One atomic upsert returns the post-increment count.
 */
export async function bumpRateLimit(
  key: string,
  windowStart: Date,
  cost = 1,
  tx: DbOrTx = getDb(),
): Promise<number> {
  const [row] = await tx
    .insert(rateLimits)
    .values({ key, windowStart, count: cost })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + ${cost}` },
    })
    .returning({ count: rateLimits.count });
  return row?.count ?? cost;
}

/** Housekeeping: fixed windows leave rows behind. Called by the daily cron task. */
export async function pruneRateLimits(before: Date, tx: DbOrTx = getDb()): Promise<void> {
  await tx.delete(rateLimits).where(lte(rateLimits.windowStart, before));
}

/**
 * The one cross-tenant read: the Twilio webhook knows a phone number and nothing
 * else. Returns ids only, so a miss reveals nothing beyond "not on any roster".
 */
export async function findWorkerByPhoneHmac(
  hmac: string,
  tx: DbOrTx = getDb(),
): Promise<{ workerId: string; companyId: string; siteId: string | null; language: string; active: boolean; consentedAt: Date | null } | null> {
  const [row] = await tx
    .select({
      workerId: workers.id,
      companyId: workers.companyId,
      siteId: workers.siteId,
      language: workers.language,
      active: workers.active,
      consentedAt: workers.consentedAt,
    })
    .from(workers)
    .where(eq(workers.phoneHmac, hmac))
    .limit(1);
  return row ?? null;
}

/** Speak-up follow-up: find the sealed case a reporter token belongs to. */
export async function findSpeakupCaseByTokenHash(hash: string, tx: DbOrTx = getDb()): Promise<Case | null> {
  const [row] = await tx
    .select()
    .from(cases)
    .where(and(eq(cases.reporterTokenHash, hash), eq(cases.isSpeakup, true)))
    .limit(1);
  return row ?? null;
}

/** Used by the Slack interactivity route, which has a channel id and nothing else. */
export async function findCaseBySlackMessage(
  channelId: string,
  messageTs: string,
  tx: DbOrTx = getDb(),
): Promise<Case | null> {
  const [row] = await tx
    .select()
    .from(cases)
    .where(and(eq(cases.slackChannelId, channelId), eq(cases.slackMessageTs, messageTs)))
    .limit(1);
  return row ?? null;
}

export { or, and, eq, desc, asc, inArray, isNull, gte, lte, lt, sql };
