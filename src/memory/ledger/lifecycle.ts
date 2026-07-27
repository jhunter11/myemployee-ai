import { z } from 'zod';

import { AppError } from '../../utils/errors';

/**
 * The LIFECYCLE axis of a memory revision.
 *
 * The research report models memory as a reducer-driven state machine over
 * immutable revisions, not as rows that get edited. Two design choices in that
 * machine are load-bearing and are encoded literally here:
 *
 *  1. `active_conflicted` is a FLAGGED RELATION, not a terminal state. A record
 *     stays usable-but-flagged while it is linked to contradictory records. That
 *     mirrors truth-maintenance practice: keep the reasons, keep the explanation
 *     structure, and do not force one side to disappear early. It can return to
 *     `active` once the contradiction is cleared.
 *  2. Lifecycle state and REVIEW state are SEPARABLE axes (see
 *     {@link MemoryApprovalStateSchema}). An operator-authored explicit preference
 *     may go `proposed -> active` while an agent inference must pass through
 *     `pending_review`. That is a policy choice about the review axis, not a
 *     different meaning on the lifecycle axis.
 */
export const MEMORY_LIFECYCLE_STATES = [
  'unseen',
  'observed_draft',
  'proposed',
  'pending_review',
  'active',
  'active_conflicted',
  'superseded',
  'retracted',
  'expired',
  'deleted_logical',
  'purge_scheduled',
  'purged'
] as const;

export const MemoryLifecycleStateSchema = z.enum(MEMORY_LIFECYCLE_STATES);
export type MemoryLifecycleState = z.infer<typeof MemoryLifecycleStateSchema>;

/**
 * The REVIEW axis. Deliberately independent of the lifecycle axis so that the
 * same lifecycle state can be reached by an auto-accepted tool observation and
 * by an operator-approved policy without conflating "where the record is in its
 * life" with "who vouched for it".
 */
export const MEMORY_APPROVAL_STATES = [
  'unknown',
  'pending',
  'auto_accepted',
  'reviewed',
  'approved',
  'rejected'
] as const;

export const MemoryApprovalStateSchema = z.enum(MEMORY_APPROVAL_STATES);
export type MemoryApprovalState = z.infer<typeof MemoryApprovalStateSchema>;

/**
 * The complete legal-transition table. Every state maps to the exhaustive set of
 * states it may move to; anything absent is denied. Self-transitions are absent
 * on purpose: a command that would not change state is a `NOOP` in the reducer
 * and writes an audit event instead of a transition.
 *
 * Notable edges and why they exist:
 *   `proposed -> active`            operator-explicit fast path (review axis carries the difference)
 *   `active <-> active_conflicted`  conflict flag is reversible; it is not an ending
 *   `expired -> superseded`         a revalidating successor may close an expired base
 *   `deleted_logical -> active`     the ONLY resurrection edge — the report's dedicated
 *                                   undelete, legal only before bytes are purged
 *   `purged -> {}`                  absolutely terminal; tombstone metadata only
 */
export const LEGAL_LIFECYCLE_TRANSITIONS: Readonly<
  Record<MemoryLifecycleState, readonly MemoryLifecycleState[]>
> = {
  unseen: ['observed_draft'],
  observed_draft: ['proposed', 'retracted', 'deleted_logical'],
  proposed: ['pending_review', 'active', 'retracted', 'deleted_logical'],
  pending_review: ['active', 'retracted', 'deleted_logical'],
  active: ['active_conflicted', 'superseded', 'retracted', 'expired', 'deleted_logical'],
  active_conflicted: ['active', 'superseded', 'retracted', 'expired', 'deleted_logical'],
  superseded: ['deleted_logical'],
  retracted: ['deleted_logical'],
  expired: ['superseded', 'retracted', 'deleted_logical'],
  deleted_logical: ['purge_scheduled', 'active'],
  purge_scheduled: ['purged', 'deleted_logical'],
  purged: []
};

/** States from which no further lifecycle movement is legal. */
export const TERMINAL_LIFECYCLE_STATES: readonly MemoryLifecycleState[] = ['purged'];

/**
 * Total over the lifecycle domain: every (from, to) pair has an answer, and the
 * answer for an unlisted edge is `false`. Deny-by-default, so a new state added
 * to the enum without a table entry cannot silently become reachable.
 */
export function canTransition(from: MemoryLifecycleState, to: MemoryLifecycleState): boolean {
  return LEGAL_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Raised when a reducer is asked to make an illegal lifecycle move. */
export class MemoryLifecycleTransitionError extends AppError {
  constructor(
    readonly from: MemoryLifecycleState,
    readonly to: MemoryLifecycleState
  ) {
    super(
      409,
      'MEMORY_LIFECYCLE_TRANSITION_ILLEGAL',
      `Illegal memory lifecycle transition '${from}' -> '${to}'`
    );
  }
}

/** Fail-closed wrapper: the reducer's only sanctioned way to move a revision. */
export function assertTransition(from: MemoryLifecycleState, to: MemoryLifecycleState): void {
  if (!canTransition(from, to)) {
    throw new MemoryLifecycleTransitionError(from, to);
  }
}

/**
 * A LIVE claim is one the conflict engine must reason about. A flagged record is
 * still live — that is precisely the point of `active_conflicted` — while
 * superseded, retracted, expired, and every deletion state are not.
 */
export function isLiveClaim(state: MemoryLifecycleState): boolean {
  return state === 'active' || state === 'active_conflicted';
}

/**
 * Default retrieval eligibility. `active_conflicted` is deliberately EXCLUDED:
 * the report requires retrieval to abstain while an unresolved conflict is
 * active, so a flagged record is reachable only through explicit
 * historical/contradiction queries, never through the default path.
 */
export function isRetrievable(state: MemoryLifecycleState): boolean {
  return state === 'active';
}

/** Legal moves on the review axis, independent of where the record sits in its life. */
export const LEGAL_REVIEW_TRANSITIONS: Readonly<
  Record<MemoryApprovalState, readonly MemoryApprovalState[]>
> = {
  unknown: ['pending', 'auto_accepted', 'reviewed', 'approved', 'rejected'],
  pending: ['reviewed', 'approved', 'rejected'],
  auto_accepted: ['pending', 'reviewed', 'approved', 'rejected'],
  reviewed: ['approved', 'rejected'],
  approved: ['rejected'],
  rejected: ['pending']
};

/** Total over the review domain; unlisted edges are denied. */
export function canReviewTransition(from: MemoryApprovalState, to: MemoryApprovalState): boolean {
  return LEGAL_REVIEW_TRANSITIONS[from].includes(to);
}

/**
 * The two axes are separable but not orthogonal everywhere: a record cannot be
 * `active` while its review says `rejected`, and it cannot sit in
 * `pending_review` while claiming to be approved. This table states exactly
 * which pairings are coherent, deny-by-default.
 *
 * Deletion states accept every review state because deletion is orthogonal to
 * vouching — a rejected draft and an approved policy are both deletable.
 */
export const REVIEW_STATES_BY_LIFECYCLE: Readonly<
  Record<MemoryLifecycleState, readonly MemoryApprovalState[]>
> = {
  unseen: ['unknown'],
  observed_draft: ['unknown', 'auto_accepted'],
  proposed: ['unknown', 'pending', 'auto_accepted'],
  pending_review: ['pending'],
  active: ['auto_accepted', 'reviewed', 'approved'],
  active_conflicted: ['auto_accepted', 'reviewed', 'approved'],
  superseded: ['auto_accepted', 'reviewed', 'approved'],
  retracted: MEMORY_APPROVAL_STATES,
  expired: ['auto_accepted', 'reviewed', 'approved'],
  deleted_logical: MEMORY_APPROVAL_STATES,
  purge_scheduled: MEMORY_APPROVAL_STATES,
  purged: MEMORY_APPROVAL_STATES
};

/** Whether a (lifecycle, review) pairing is a coherent state of the world. */
export function isReviewCompatible(
  lifecycle: MemoryLifecycleState,
  review: MemoryApprovalState
): boolean {
  return REVIEW_STATES_BY_LIFECYCLE[lifecycle].includes(review);
}
