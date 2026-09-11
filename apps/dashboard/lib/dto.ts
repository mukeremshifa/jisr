import { filsToAed, languageOf, type CaseStatus } from '@jisr/core';
import type { Case, PayAdjustment } from '@jisr/db';

/**
 * Per-role response shapes.
 *
 * Nothing here returns a raw row. A worker's phone number, a reporter token and
 * every encrypted column stay on the server; a speak-up case never carries a
 * worker reference at all.
 */

export interface CaseListItem {
  publicId: string;
  category: string;
  severity: string;
  status: CaseStatus;
  siteName: string | null;
  assetLabel: string | null;
  summaryEn: string;
  language: string;
  languageName: string;
  isSpeakup: boolean;
  confirmedByWorker: boolean;
  needsReview: boolean;
  injectionSuspected: boolean;
  workerRef: string | null;
  createdAt: string;
  slaDueAt: string | null;
  pastSla: boolean;
  ageMinutes: number;
}

export function toCaseListItem(
  row: Case,
  extras: { siteName: string | null; assetLabel: string | null; workerRef: string | null },
  now: Date = new Date(),
): CaseListItem {
  const pastSla = Boolean(row.slaDueAt && row.slaDueAt < now && !row.firstResponseAt);
  return {
    publicId: row.publicId,
    category: row.category ?? 'other',
    severity: row.severity ?? 'medium',
    status: row.status as CaseStatus,
    // A speak-up report carries no site and no worker, by construction.
    siteName: row.isSpeakup ? null : extras.siteName,
    assetLabel: row.isSpeakup ? null : extras.assetLabel,
    summaryEn: row.summaryEn ?? '',
    language: row.language,
    languageName: languageOf(row.language).name,
    isSpeakup: row.isSpeakup,
    confirmedByWorker: row.confirmedByWorker,
    needsReview: row.needsReview,
    injectionSuspected: row.injectionSuspected,
    workerRef: row.isSpeakup ? null : extras.workerRef,
    createdAt: row.createdAt.toISOString(),
    slaDueAt: row.slaDueAt?.toISOString() ?? null,
    pastSla,
    ageMinutes: Math.round((now.getTime() - row.createdAt.getTime()) / 60_000),
  };
}

export interface TimelineItem {
  id: string;
  kind: 'message' | 'event';
  direction: 'inbound' | 'outbound' | null;
  textOriginal: string | null;
  textEn: string | null;
  language: string | null;
  rtl: boolean;
  mediaUrl: string | null;
  mediaKind: 'image' | 'audio_in' | 'audio_out' | null;
  label: string | null;
  at: string;
}

export interface PayRow {
  id: string;
  casePublicId: string;
  workerRef: string;
  period: string;
  kind: string;
  hours: string;
  amountAed: string;
  status: string;
  proposedBy: string | null;
  approvedBy: string | null;
  /** A short prefix is enough to show the binding without publishing the digest. */
  hashShort: string;
  decidedAt: string | null;
  executedAt: string | null;
}

export function toPayRow(
  row: PayAdjustment,
  extras: { casePublicId: string; workerRef: string; proposedBy: string | null; approvedBy: string | null },
): PayRow {
  return {
    id: row.id,
    casePublicId: extras.casePublicId,
    workerRef: extras.workerRef,
    period: row.period,
    kind: row.kind,
    hours: (row.hoursX100 / 100).toFixed(2),
    amountAed: filsToAed(row.amountFils),
    status: row.status,
    proposedBy: extras.proposedBy,
    approvedBy: extras.approvedBy,
    hashShort: row.payloadSha256.slice(0, 12),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
  };
}
