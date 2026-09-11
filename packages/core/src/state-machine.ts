import type { CaseStatus } from './schemas';

/**
 * The case state machine from the brief, as data. Every transition is named so
 * `case_events.type` and the machine cannot drift apart.
 *
 *   new ──(emergency)──▶ critical_open
 *    └─▶ clarifying ─▶ awaiting_confirmation ─▶ confirmed ─▶ routed ─▶ in_progress
 *                                                              └─(SLA)─▶ escalated
 *        routed/in_progress ─▶ decided ─▶ closed, and closed ─▶ reopened
 *
 *   Pay cases after routed: pending_supervisor ─▶ pending_hr ─▶ approved ─▶ executed
 *                                                           └─▶ denied | expired
 */

export const TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  new: ['clarifying', 'awaiting_confirmation', 'confirmed', 'critical_open', 'routed'],
  critical_open: ['in_progress', 'decided', 'closed', 'escalated'],
  clarifying: ['clarifying', 'awaiting_confirmation', 'confirmed', 'routed', 'critical_open'],
  awaiting_confirmation: ['confirmed', 'clarifying', 'routed', 'critical_open'],
  confirmed: ['routed', 'critical_open'],
  routed: ['in_progress', 'escalated', 'decided', 'closed', 'pending_supervisor'],
  escalated: ['in_progress', 'decided', 'closed'],
  in_progress: ['decided', 'closed', 'escalated'],
  decided: ['closed', 'reopened'],
  closed: ['reopened'],
  reopened: ['routed', 'in_progress', 'escalated', 'decided'],

  pending_supervisor: ['pending_hr', 'denied', 'expired', 'closed'],
  pending_hr: ['approved', 'denied', 'expired'],
  approved: ['executed', 'denied'],
  executed: ['closed'],
  denied: ['closed', 'reopened'],
  expired: ['closed', 'reopened', 'pending_supervisor'],
};

/** Terminal for the worker-facing flow. Reopening is an explicit new transition. */
export const TERMINAL_STATUSES: readonly CaseStatus[] = ['closed'];

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: CaseStatus,
    readonly to: CaseStatus,
  ) {
    super(`invalid case transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/** Use at every write site so an out-of-order webhook cannot corrupt a case. */
export function assertTransition(from: CaseStatus, to: CaseStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Statuses where the worker is still expected to reply. */
export const AWAITING_WORKER: readonly CaseStatus[] = ['clarifying', 'awaiting_confirmation'];

/** Statuses that count as "open" on the dashboard and in SLA counts. */
export const OPEN_STATUSES: readonly CaseStatus[] = [
  'new',
  'clarifying',
  'awaiting_confirmation',
  'confirmed',
  'routed',
  'escalated',
  'in_progress',
  'reopened',
  'critical_open',
  'pending_supervisor',
  'pending_hr',
  'approved',
];

export function isOpen(status: CaseStatus): boolean {
  return OPEN_STATUSES.includes(status);
}
