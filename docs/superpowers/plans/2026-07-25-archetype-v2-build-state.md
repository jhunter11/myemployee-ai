# BUILD STATE — Agent Archetype Generalization V2

> **Resume file.** V1 is complete in
> `2026-07-25-archetype-build-state.md`. This file owns the intentionally
> digest-changing V2 increment.

## Authorized outcomes

V2 implements the four outcomes named in
`2026-07-25-agent-archetype-generalization.md`:

1. instantiate an approved pod recipe into an exact `company`, `client`, or
   `project` control scope at runtime;
2. add the missing Growth verifier;
3. add the missing Delivery and Knowledge reviewers; and
4. add Finance and Marketing recipes.

The static catalog remains bounded and deterministic, but V2 intentionally
changes its contents and digest. Runtime instances are persisted separately and
never appended to `listAgentProfiles()`.

## Locked implementation decisions

- The static catalog grows from 34 to **45 profiles**: three missing roles plus
  four Finance profiles and four Marketing profiles.
- Finance is evidence-only. It may reconcile measured known costs and
  unrecognized pipeline counts, but it cannot invoice, move money, value the
  pipeline, recognize revenue, or claim realized margin.
- Marketing is plan/review/gate-only. It cannot access an account, render with a
  paid provider, spend, publish, or claim performance or revenue.
- `PodRecipe.runtimeInstantiable` is an explicit allowlist. A runtime recipe
  must contain only generalizable archetypes. Delivery, Seller, and Settlement
  remain static because they contain an operator or auditor.
- A runtime profile is a run-bounded `template`, even when its static recipe
  lead is durable.
- Runtime memory never inherits `${trustDomain}:core`. Every non-scratch sleeve
  is deterministically rebound into the exact registered owner scope; no parent
  or sibling scope is inherited.
- Only `blueprint` grants are installed. The result always reports
  `authorizationReady: false`; operator, tenant, channel, and run layers remain
  separately required.
- Instance IDs and grant IDs are digest-derived and bounded. Request text never
  selects an agent ID, trust domain, parent agent, or grant.
- The canonical profile/access manifest is stored before access installation in
  `planned` state, then becomes `active` only after exact grant-set audit.
  Interrupted planned installs are replayable from the stored snapshot, not
  from the current recipe code.
- `catalogSha256`, recipe digest, and instance-manifest digest remain distinct.
- Knowledge bindings stay on the existing knowledge contract:
  - `project:<subject>` for project control scopes;
  - `client:<subject>` for client control scopes; and
  - `project:company_<subject>` for company control scopes.

## Tasks

- [x] **1. V2 catalog tests** — assert 45 ordered profiles, complete Growth /
      Delivery / Knowledge composition, Finance and Marketing boundaries, and
      explicit runtime-instantiable recipe flags.
- [x] **2. V2 recipes** — add the three missing members and the two four-profile
      recipes as domain-only data.
- [x] **3. Instance manifest tests** — cover deterministic IDs and digests,
      exact sleeve rebinding, no domain-core inheritance, long identifiers,
      company/client/project knowledge bindings, and rejection of
      non-generalizable recipes.
- [x] **4. Durable registry** — add immutable planned/active manifest and member
      tables plus an exact, digest-verifying repository.
- [x] **5. Instance installer** — plan first, bind exact pre-registered control
      and knowledge scopes, idempotently install agents, sleeves, and blueprint
      grants, audit exact active grant IDs, activate, and resume planned
      installs.
- [x] **6. Runtime resolution** — inject an async instance resolver into agent
      conversations while keeping the directory/hierarchy static and bounded.
- [x] **7. Golden catalog** — regenerate the approved 45-profile fixture and pin
      its new digest.
- [x] **8. Verify** — focused tests, typecheck, lint, format, then
      `npm run verify:framework`. Verification found four failing lifecycle
      tests and closed them; see task 9.
- [x] **9. Lease expiry** — the verify pass found the runtime instance lifecycle
      had no way to close a lease: `initialize()` re-provisioned lapsed
      instances, and a recipe scope could never be renewed. Added the quarantined
      `expired` state, and closed an undeclared-authority hole the same tests
      named.

## Task 9 in detail

Four tests in `tests/agents/profile-instance-service.test.ts` were red against
the implementation. Closing them changed five things:

- `ProfileInstanceManifestSchema` now checks grants **both ways** against the
  member profile snapshots. A manifest may carry only the sleeves, sleeve
  grants, and tool grants its profiles declare, and must carry all of them.
  Cover is compared as authority tuples, not grant counts, so two grants naming
  one tuple cannot balance the count while a declared permission goes unissued.
- Migration 026 gains an `expired` lease state and an `expired_at` column. Its
  table-level `UNIQUE (recipe_id, scope_id)` becomes a partial unique index
  excluding quarantined rows, so exactly one live lease exists per recipe scope
  while retired ones are retained as immutable history. The activation trigger
  becomes `agent_profile_instances_governed_transition`, admitting exactly two
  transitions: planned → active inside the lease window, and planned or active →
  expired at or after `expires_at`.
- `addProfileInstanceExpiry` in `programmatic-migrations.ts` rebuilds the legacy
  table in place, matching the existing cost-basis precedent. It needs
  `legacy_alter_table` because `agent_profile_instance_members` carries a
  trigger naming the parent table, which a modern rename would reparse
  mid-rebuild.
- The instance ID digest now covers the whole approved lease (recipe, scope,
  scope version, operator, created, expires) rather than just the recipe scope,
  so a renewal after quarantine is a distinct instance with distinct derived
  agent IDs. Replanning the same lease is still byte-identical, which is what
  keeps installation idempotent.
- `initialize()` reports `{ expiredCount, resumedCount, auditedCount }` and
  sweeps in bounded keyset pages sized by `recoveryBatchSize`, quarantining
  lapsed leases before anything is provisioned.

## Current validation

- Static catalog fixture: **45 profiles**.
- Approved V2 catalog SHA-256:
  `cdcffef38070d30bd49c85c886bdb1de7de887534a4b3d17e4afeb8abf0515d9`.
- `npm run verify:framework`: **passed end to end** — format:check, lint,
  typecheck, `vitest run --coverage`, build, task-market build, memory-graph
  rebuild, and `git diff --check`.
- Full suite: **2238 tests / 209 files passed**.
- Coverage against the 85% global thresholds: statements 92.32%, **branches
  85.08%**, functions 95.99%, lines 93.72%.
- The lease-expiry slice landed with its own tests:
  `tests/agents/profile-instance-repository.test.ts` (new),
  `tests/agents/profile-instance-contracts.test.ts` (new, 24 tampering cases),
  and the profile-instance rebuild cases in
  `tests/db/programmatic-migrations.test.ts`.
- Verified against a copy of a real dev database carrying the legacy table
  shape: rows preserved, indexes and all three triggers restored, no new
  foreign-key violations, and a second run is a no-op.

## Drift that remains out of scope

- No generic coordinator, operator, or auditor.
- No automatic instantiation during client onboarding.
- No public request route that accepts a tenant or scope.
- No runtime grant layers beyond blueprint.
- No regularization of existing MCP/x402 reviewer/verifier sleeve names.
- No Finance billing ledger or Marketing publisher.
- No recipe upgrade workflow; manifest drift fails closed. Lease expiry
  quarantines a lapsed instance and frees its recipe scope for a renewal, but it
  does not revoke the retired instance's registered agents, and renewal is still
  an explicit operator-approved `instantiate` call — nothing renews itself.
