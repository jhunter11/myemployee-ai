# Durable priority queue core

**Date:** 2026-07-18
**Status:** implementation contract

## Orientation

**Domains involved:** control-plane scheduling, tenant security, worker operations, auditability, and operator observability.

**Assumptions validated:** Jarvis needs one durable scheduler primitive rather than a model-authored priority list; the current global SQLite database remains its single source of truth; a worker is always scoped to one tenant before it can claim work.

**Existing constraints:** deny-first tenant ownership, deterministic behavior before model calls, bounded dashboard reads, append-only operational evidence, and restart-safe SQLite transactions.

**Trajectory:** v1 is a queue core consumed by supervisors and future dashboards. It does not spawn agents or expose an HTTP mutation surface.

## Contract

The hierarchy is `tenant -> lane -> ready task`. Every task has:

- a source identity, unique within its tenant, for exact retry idempotency;
- a strict discriminated payload containing only opaque references;
- a fixed policy band (`P0` through `P3`), objective integer impact/urgency/effort inputs, and an immutable enqueue timestamp;
- zero or more same-tenant dependencies;
- an optimistic version and, while claimed, a bounded lease.

Models never assign or adjust priority. The deterministic within-band score is:

```text
base = impact * 4 + urgency * 5 + (11 - effort)
effective = base + min(100, floor(waiting_minutes / 15))
```

Aging is capped and never promotes a task across a policy band. Selection first computes one ready head per lane. Across heads in the same highest available policy band, the least-recently-served lane wins; effective score and immutable task identity are deterministic tie breakers. This preserves hard policy bands while providing round-robin fairness among peers.

Claiming performs candidate selection, optimistic state transition, lease issuance, lane-cursor advancement, and decision-event append in one database transaction. Expired leases are reclaimable; a stale lease token or task version cannot settle the reclaimed task.

Dependency edges are same-tenant composite foreign keys. Dependencies are immutable and must already exist, so the public enqueue path cannot introduce a cycle. A task is ready only when every dependency succeeded and its availability time has arrived.

Task events are append-only at the database layer. The read side is tenant-scoped and bounded. It never selects payload JSON, source identifiers, lease tokens, worker identifiers, or event detail JSON; it returns only operational metadata and payload kind.

## Failure behavior

- A conflicting source replay fails closed.
- A missing, self, or cross-tenant dependency is rejected transactionally.
- A claim race can produce at most one active lease for a task.
- Version or lease mismatch rejects settlement without appending a false event.
- Failed dependencies keep dependants blocked and visible only as redacted metadata.
