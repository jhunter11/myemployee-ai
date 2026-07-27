# Priority queue workflow

Use this lane for task ordering, agent coordination, dependencies, claims, leases, or queue views.

## Preserve the hierarchy

- Order work as tenant → revenue lane → readiness → P0–P3 policy band.
- Keep scoring deterministic and auditable. Models may describe work but never assign authority or
  final priority.
- Bind the operator read model to the configured harness tenant. Never accept a tenant selector
  from the operator browser or a client prompt.
- Return only allowlisted task metadata. Keep source details, policy scores, payloads and leases
  worker-only.

## Change safely

1. Inspect `src/queue/`, the queue repository, migration, and focused tests.
2. Write a failing test for ordering, fairness, dependency, lease, or redaction behavior.
3. Preserve source idempotency, same-tenant dependencies, optimistic versions, bounded leases, and
   append-only decisions.
4. Make blocked work visible without allowing it to displace ready work.
5. Explain every dashboard ordering with bounded “Why now” evidence.

## Verify

Test cross-tenant denial, duplicate sources, dependency invalidation, lease expiry, stale workers,
same-band fairness, lane fairness, output limits, and payload/lease redaction.
