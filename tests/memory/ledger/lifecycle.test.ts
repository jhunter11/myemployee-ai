import { describe, expect, it } from 'vitest';

import {
  assertTransition,
  canReviewTransition,
  canTransition,
  isLiveClaim,
  isReviewCompatible,
  isRetrievable,
  LEGAL_LIFECYCLE_TRANSITIONS,
  LEGAL_REVIEW_TRANSITIONS,
  MEMORY_APPROVAL_STATES,
  MEMORY_LIFECYCLE_STATES,
  MemoryLifecycleTransitionError,
  REVIEW_STATES_BY_LIFECYCLE,
  TERMINAL_LIFECYCLE_STATES
} from '../../../src/memory/ledger/lifecycle';

describe('memory lifecycle state machine', () => {
  it('is a total, closed table over the declared states', () => {
    for (const state of MEMORY_LIFECYCLE_STATES) {
      const targets = LEGAL_LIFECYCLE_TRANSITIONS[state];
      expect(targets).toBeDefined();
      for (const target of targets) {
        expect(MEMORY_LIFECYCLE_STATES).toContain(target);
      }
      // No duplicate edges, so the table cannot drift into ambiguity.
      expect(new Set(targets).size).toBe(targets.length);
      // A no-op is an audit event, never a transition.
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('keeps ACTIVE_CONFLICTED usable-but-flagged rather than terminal', () => {
    expect(TERMINAL_LIFECYCLE_STATES).toEqual(['purged']);
    expect(canTransition('active', 'active_conflicted')).toBe(true);
    // The flag is reversible: clearing a contradiction returns the record to active.
    expect(canTransition('active_conflicted', 'active')).toBe(true);
    for (const target of ['superseded', 'retracted', 'expired', 'deleted_logical'] as const) {
      expect(canTransition('active_conflicted', target)).toBe(true);
    }
    // A flagged record is still a live claim the conflict engine must consider...
    expect(isLiveClaim('active_conflicted')).toBe(true);
    // ...but default retrieval abstains while the contradiction is unresolved.
    expect(isRetrievable('active_conflicted')).toBe(false);
    expect(isRetrievable('active')).toBe(true);
    expect(isLiveClaim('superseded')).toBe(false);
    expect(isLiveClaim('expired')).toBe(false);
  });

  it('denies every move out of PURGED', () => {
    for (const target of MEMORY_LIFECYCLE_STATES) {
      expect(canTransition('purged', target)).toBe(false);
    }
    expect(LEGAL_LIFECYCLE_TRANSITIONS.purged).toEqual([]);
  });

  it('denies backwards and skipped moves, fail closed', () => {
    expect(canTransition('active', 'proposed')).toBe(false);
    expect(canTransition('active', 'pending_review')).toBe(false);
    expect(canTransition('superseded', 'active')).toBe(false);
    expect(canTransition('retracted', 'active')).toBe(false);
    expect(canTransition('unseen', 'active')).toBe(false);
    expect(canTransition('proposed', 'superseded')).toBe(false);
    expect(canTransition('purge_scheduled', 'active')).toBe(false);
  });

  it('allows the operator fast path and the single sanctioned resurrection edge', () => {
    // Operator-explicit statements skip review on the LIFECYCLE axis.
    expect(canTransition('proposed', 'active')).toBe(true);
    expect(canTransition('proposed', 'pending_review')).toBe(true);
    expect(canTransition('pending_review', 'active')).toBe(true);
    // Undelete is legal only before the bytes are gone.
    expect(canTransition('deleted_logical', 'active')).toBe(true);
    expect(canTransition('purge_scheduled', 'deleted_logical')).toBe(true);
    expect(canTransition('purge_scheduled', 'purged')).toBe(true);
    // A revalidating successor may close an expired base.
    expect(canTransition('expired', 'superseded')).toBe(true);
  });

  it('throws a typed, fail-closed error on an illegal transition', () => {
    expect(() => assertTransition('active', 'active_conflicted')).not.toThrow();
    expect(() => assertTransition('purged', 'active')).toThrow(MemoryLifecycleTransitionError);
    try {
      assertTransition('superseded', 'active');
      expect.unreachable('illegal transition must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryLifecycleTransitionError);
      expect(error).toMatchObject({
        code: 'MEMORY_LIFECYCLE_TRANSITION_ILLEGAL',
        statusCode: 409,
        from: 'superseded',
        to: 'active'
      });
    }
  });
});

describe('memory review axis', () => {
  it('is a total, closed table with no self-edges', () => {
    for (const state of MEMORY_APPROVAL_STATES) {
      const targets = LEGAL_REVIEW_TRANSITIONS[state];
      for (const target of targets) {
        expect(MEMORY_APPROVAL_STATES).toContain(target);
      }
      expect(canReviewTransition(state, state)).toBe(false);
    }
  });

  it('lets approval be revoked but never silently restored', () => {
    expect(canReviewTransition('approved', 'rejected')).toBe(true);
    expect(canReviewTransition('rejected', 'approved')).toBe(false);
    // A rejected record must be resubmitted before it can be approved again.
    expect(canReviewTransition('rejected', 'pending')).toBe(true);
    expect(canReviewTransition('pending', 'approved')).toBe(true);
    expect(canReviewTransition('reviewed', 'approved')).toBe(true);
    expect(canReviewTransition('approved', 'pending')).toBe(false);
  });

  it('keeps the two axes separable but coherent', () => {
    for (const lifecycle of MEMORY_LIFECYCLE_STATES) {
      const allowed = REVIEW_STATES_BY_LIFECYCLE[lifecycle];
      expect(allowed.length).toBeGreaterThan(0);
      for (const review of MEMORY_APPROVAL_STATES) {
        expect(isReviewCompatible(lifecycle, review)).toBe(allowed.includes(review));
      }
    }
    // An active record must have been vouched for by something.
    expect(isReviewCompatible('active', 'approved')).toBe(true);
    expect(isReviewCompatible('active', 'auto_accepted')).toBe(true);
    expect(isReviewCompatible('active', 'pending')).toBe(false);
    expect(isReviewCompatible('active', 'rejected')).toBe(false);
    // Sitting in review means the review is pending, by definition.
    expect(isReviewCompatible('pending_review', 'pending')).toBe(true);
    expect(isReviewCompatible('pending_review', 'approved')).toBe(false);
    // Deletion is orthogonal to vouching: a rejected draft is as deletable as a policy.
    expect(isReviewCompatible('deleted_logical', 'rejected')).toBe(true);
    expect(isReviewCompatible('purged', 'unknown')).toBe(true);
    // The same lifecycle state is reachable by auto-accepted and operator-approved
    // records alike — that is exactly what "separable axes" buys.
    expect(isReviewCompatible('active', 'reviewed')).toBe(true);
  });
});
