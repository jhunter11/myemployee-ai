# Jarvis Production Reliability and Governed Self-Management Task Plan

**Date:** 2026-07-22

**Status:** Active implementation roadmap

**Source specifications:**

- `docs/superpowers/specs/2026-07-22-reliability-spine-design.md`
- `docs/superpowers/specs/2026-07-22-governed-self-editing-workbench-design.md`
- `docs/superpowers/specs/2026-07-21-hierarchical-control-site-design.md`
- `docs/superpowers/specs/2026-07-21-dashboard-refactor-design.md`

## Outcome

Deliver the step after MVP: a locally operated Jarvis that remains usable through the dashboard,
keeps durable conversations and work state, proves automation completion before reporting success,
alerts the operator without granting Telegram authority, and can inspect, draft, test, and present
changes to its own repository through an exact operator-governed lifecycle.

“Self-editing” means Jarvis may create a bounded change proposal in an isolated worktree, produce a
reviewable diff and test evidence, and ask the operator to approve an exact fingerprint. Jarvis may
not approve itself, merge to a protected branch, alter its grader or authority, read arbitrary
tenant data, or activate the resulting release. Release activation remains a separately signed
operator action verified by the reliability spine.

## Task List

**Total tasks:** 32

**Estimated sessions:** 24–36 focused build sessions plus the real 14-day acceptance window

### Dependency-valid execution graph

- Reliability foundation: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10.
- Observer branch: 3 → 11; 4 + 11 → 12; 3 → 13; 7 + 12 + 13 → 14;
  2 + 13 → 15 → 16; 14 + 16 → 17.
- Release branch: 9 + 17 → 18 → 19 → 20 → 21; 17 + 21 → 22.
- Improvement branch: 2 + 8 → 23 → 24; 10 + 24 → 25.
- Governed-change branch: 2 + 10 → 26; 18 + 26 → 27; 10 + 26 → 28;
  27 + 28 → 29.
- Operator handoff joins: 25 + 29 → 30; 21 + 30 → 31; 22 + 31 → 32.

Tasks on different branches may proceed in parallel only after every predecessor shown above is
complete. In particular, the isolated change executor waits for the canonical release gate, and
production acceptance waits for both activation proof and the approved-branch workflow.

### Agent provisioning

Tasks below are dependency-scoped, not assignment-scoped. For file-ownership lanes, per-packet
done-when criteria, and the concurrency map, see
`docs/superpowers/plans/2026-07-22-remaining-work-provisioning.md`.

### Implementation checkpoint — 2026-07-22

| Task | Status                        | Fresh evidence and remaining boundary                                                                                                                                                                                                                                                                             |
| ---- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Complete                      | The operator-confirmed reliability specification contains the byte protocol and a separate governed self-editing authority contract.                                                                                                                                                                              |
| 2    | Complete                      | Strict canonical JSON, UTC/framing rules, all 18 identity factories, hard-coded cross-process vectors, mutation cases, and bounded parser failures pass the full repository gate.                                                                                                                                 |
| 3    | In progress                   | Schema version 19, atomic marker migration, exact manifest validation, bounded query-only WAL reads, identity/source recomputation, fixed lock timeout, stable errors, and forbidden-import tests are green. The private settlement writer and observer-only composition root remain intentionally unimplemented. |
| 4    | In progress (substrate green) | Artifact claims, source claims, immutable candidates, holds, atomic freeze/replay, identity/digest validation, posture/lease checks, and held-task fencing are green. Acceptance remains dependency-gated on Task 3 and the registered adapter in Task 5.                                                         |
| 5–32 | Not started                   | No production activation, schedule, proactive Telegram, release attestation, ToolSmith execution, branch application, or self-editing runtime is claimed.                                                                                                                                                         |

Checkpoint gate: 120 test files / 1,079 tests, 85.25% branch coverage, formatting, lint,
typecheck, production build, task-market build, memory-graph validation, and whitespace checks all
pass. This is implementation evidence for the foundation only, not production acceptance.

---

### Task 1: Freeze implementation decisions

**Type:** alignment / specification
**Depends on:** none
**Complexity:** moderate

Record the byte-framing, registry, evidence-missing, Telegram rotation, proof-persistence, candidate
publication, watchdog-intent, and migration-cutover decisions in the reliability specification.

**Done when:** the spec is confirmed, contains no implementation-blocking ambiguity from gap
analysis, and explicitly separates deterministic witnessing from governed self-editing.

### Task 2: Shared canonical evidence protocol

**Type:** code
**Depends on:** Task 1
**Complexity:** moderate

Implement strict canonical JSON, raw JSON duplicate detection, UTC timestamp validation,
length-prefixed domain hashing, and golden identity fixtures.

**Done when:** malformed/noncanonical inputs fail closed; golden hashes are stable across fresh
processes; typecheck, lint, and focused tests pass.

### Task 3: Versioned primary database ports

**Type:** infrastructure / code
**Depends on:** Task 2
**Complexity:** complex (Level 3)

Add an exact supported schema version, bounded query-only WAL reader, private guarded writer, and
architecture checks that keep generic agent/worker paths away from settlement mutations.

**Done when:** wrong/newer schema versions, writes through the reader, unbounded busy waits, and
forbidden imports fail tests.

### Task 4: Verification freeze substrate

**Type:** code
**Depends on:** Tasks 2–3
**Complexity:** complex (Level 3)

Add artifact claims, source snapshots, immutable completion candidates, verification holds, atomic
freeze/replay, and hold-aware lease fencing.

**Done when:** exact replay is idempotent; conflicting identity, stale CAS, expired lease, posture
drift, partial failure, mutation, and held-task reclaim all fail without partial state.

### Task 5: Registered daily-report candidate adapter

**Type:** code
**Depends on:** Task 4
**Complexity:** complex

Bind the one registered artifact scope and source to no-follow source snapshots and claim-scoped
candidate staging. Split live publication from candidate freeze.

**Done when:** source/result/artifact/journal digests are independently reproducible and no worker or
request text can choose a path or scope.

### Task 6: Pending execution semantics

**Type:** code / alignment
**Depends on:** Task 5
**Complexity:** complex

Change Supervisor, queue-cycle, direct API, recovery, and read models from runner-resolved success to
`pending_verification`; return a bounded `202` receipt and label historical success
`legacy_unverified`.

**Done when:** no ordinary runtime path can write new success and all API/dashboard consumers and
regressions reflect the pending state.

### Task 7: Deterministic verifier and guarded settlement

**Type:** code
**Depends on:** Task 6
**Complexity:** complex (Level 3)

Replace citation-only verification with the exact daily-report verifier, branded results, finite
attempts, append-only attempt evidence, proof joins, and guarded success/failure transactions.

**Done when:** a worker result, citation, stale run, wrong source, unsafe artifact, or mismatched
identity cannot mint proof; pass/fail replay returns the same receipt.

### Task 8: Verified projection finalizer

**Type:** code
**Depends on:** Task 7
**Complexity:** complex (Level 3)

Implement frozen projector registries, effect journals, live artifact publication, memory/diagram/
frequency projections, receipts, retries, and crash recovery.

**Done when:** every effect is compare-or-create and idempotent; unresolved/terminal projection state
is visible and blocks readiness where specified.

### Task 9: Restart and legacy cutover matrix

**Type:** code / infrastructure
**Depends on:** Task 8
**Complexity:** complex

Implement exact restart behavior for executing claims, frozen candidates, holds, proofs, projection
jobs, interrupted attempts, and legacy succeeded runs.

**Done when:** crash-boundary tests cover every transaction boundary without duplicate execution,
lost evidence, unsafe rollback, or legacy proof reuse.

### Task 10: Proof-aware dashboard projections

**Type:** page / dashboard
**Depends on:** Task 9
**Complexity:** moderate

Expose bounded verification state, holds, projections, and safe reason codes through existing
allowlisted read models and widgets.

**Done when:** the operator can distinguish running, awaiting proof, finalizing, verified, failed,
legacy-unverified, and unavailable states at desktop and 390px with no console errors.

### Task 11: Approved schedule and activation history

**Type:** code / alignment
**Depends on:** Task 3
**Complexity:** complex

Add strict immutable schedule/config/policy files, exact local approval, deny-default activation, and
append-only active windows.

**Done when:** zero/multiple/mismatched schedules are `NO_GO`; text and agents cannot select or alter
tenant, automation, time, verifier, or activation.

### Task 12: Deterministic occurrence materializer

**Type:** code
**Depends on:** Tasks 4 and 11
**Complexity:** complex

Derive bounded UTC slots and exact occurrence/execution/task/run IDs; enforce posture and tenant
evidence before idempotent queue creation.

**Done when:** boundary, replay, missed-window, disabled, evidence-missing, wrong-release, and no
catch-up tests pass.

### Task 13: Independent reliability ledger

**Type:** infrastructure / code
**Depends on:** Task 3
**Complexity:** complex

Create the owner-only reliability SQLite ledger for leases, cycles, incidents, acknowledgments,
accepted loss, bindings, outbox, attempts, and bounded summaries.

**Done when:** migrations replay, append-only/CAS guards hold, permissions are exact, and the gateway
receives only the bounded reader.

### Task 14: Reliability observer process

**Type:** code / operations
**Depends on:** Tasks 7, 12–13
**Complexity:** complex (Level 3)

Build the separate one-shot observer with a fair 45-second work budget, exact classifications,
finite verification work, incident reconciliation, and safe nonzero failure exits.

**Done when:** fake-clock and gateway-stopped tests detect every specified missing, late, stale,
failed, unavailable, backlog, and accepted-loss state within its bound.

### Task 15: Strict Telegram transport and binding activation

**Type:** integration / code
**Depends on:** Tasks 2 and 13
**Complexity:** complex

Parse bounded Bot API receipts/errors, enforce the eight-second deadline, persist inbound activation
evidence, and activate only the exact private user/chat/config binding.

**Done when:** wrong chat, user, type, bot flag, config, receipt, timeout, malformed response, and
rotation all fail closed without exposing secrets.

### Task 16: Durable proactive notification outbox

**Type:** code
**Depends on:** Task 15
**Complexity:** complex

Add fixed templates, SLA-bound outbox rows, leases, five finite attempts, `retry_after`, ambiguity,
exhaustion, exact sixth-try approval, and cross-database reconciliation.

**Done when:** crash/replay/fake-clock tests prove at-least-once attempts, one terminal receipt, no
destination/body injection, and observable exhausted delivery.

### Task 17: Observer/watchdog/readiness integration

**Type:** operations / code
**Depends on:** Tasks 14 and 16
**Complexity:** complex

Install the third LaunchAgent, aggregate watchdog probes, atomically publish observer status, and
feed bounded reliability summaries into readiness and runtime audit.

**Done when:** stale/missing observer, DB loss, open P0/P1, exhausted delivery, drift, hostile env,
and restart scenarios are `NO_GO` without early-exit masking.

### Task 18: Canonical release gate and toolchain lock

**Type:** infrastructure / operations
**Depends on:** Tasks 9 and 17
**Complexity:** complex

Pin the exact Node patch/checksum and implement one clean-tree release gate covering formatting,
lint, types, tests/coverage, build, graph, architecture rules, and diff integrity.

**Done when:** tracked/untracked dirt, toolchain drift, omitted tests, and manifest changes fail the
same command locally and in CI.

### Task 19: Deterministic bundle and release manifest

**Type:** operations / code
**Depends on:** Task 18
**Complexity:** complex

Generate the bounded path/mode/hash manifest, deterministic ustar bundle, cycle-free envelope, and
retained candidate evidence.

**Done when:** repeated builds are byte-identical and extra, missing, symlinked, wrong-mode, or
mutated files fail verification.

### Task 20: Signed intent, trust registry, and installer

**Type:** security / operations
**Depends on:** Task 19
**Complexity:** complex (Level 3)

Implement independent approval root, monotonic host-key registry, exact install plan fingerprint,
crash-safe cutover journal, retained rollback, and no automatic launchctl.

**Done when:** stale/replayed/wrong-host/wrong-key/wrong-registry approvals and interrupted cutovers
cannot change live intent or trust.

### Task 21: Independent live auditor and CI attestation

**Type:** security / infrastructure
**Depends on:** Task 20
**Complexity:** complex

Hash installed bytes and launchd state against independent intent, sign bounded live evidence, and
verify it in protected read-only GitHub workflows with retained candidate artifacts.

**Done when:** candidate CI and live-host equality are separate mandatory checks and every negative
drift fixture yields `NO_GO`.

### Task 22: Production activation gate

**Type:** alignment / operations
**Depends on:** Tasks 17 and 21
**Complexity:** complex

Require verified settlement, fresh observer, delivered test push, exact signed release intent, and
operator-approved schedule before activation.

**Done when:** one exact local decision activates only the attested configuration; any changed
digest/version returns deny-default.

### Task 23: Frequency V2 and legacy quarantine

**Type:** code / migration
**Depends on:** Tasks 2 and 8
**Complexity:** complex

Add exact-field verified frequency observations and a frozen catalog-proven import/quarantine path
for opaque legacy signatures.

**Done when:** only one verified projection updates V2; no delimiter inference or legacy row feeds
ToolSmith directly.

### Task 24: Durable ToolSmith observations

**Type:** code
**Depends on:** Task 23
**Complexity:** complex

Persist tenant-scoped immutable proposals, observations, and scan events with bounded retry and
literal proposal-only/non-executable constraints.

**Done when:** reopen/replay/tenant/failure tests pass and ToolSmith has no queue, blueprint,
filesystem, network, subprocess, approval, or frequency-write capability.

### Task 25: Persisted improvement dashboard

**Type:** page / dashboard
**Depends on:** Tasks 10 and 24
**Complexity:** moderate

Replace recomputation-on-read with scoped persisted proposal views, evidence summaries, and a human
action to begin a separate governed change request.

**Done when:** the dashboard never calls `analyze()` on read and request text cannot choose another
tenant or promote a proposal.

### Task 26: Governed repository-change contracts

**Type:** specification / code
**Depends on:** Tasks 2 and 10
**Complexity:** complex (Level 3)

Define immutable change requests, source revision, allowed path set, authority ceiling, plan/diff/
test digests, attempts, decisions, and terminal states. Reuse exact-state local approvals.

**Done when:** a change cannot broaden its own tools, paths, policy, grader, approval, release, or
secrets access, and conflicting replay is an integrity failure.

### Task 27: Isolated change-workspace executor

**Type:** code / operations
**Depends on:** Tasks 18 and 26
**Complexity:** complex

Create a bounded detached worktree/branch, sanitized environment, allowlisted tool runner, file/
output limits, timeout, cancellation, and recoverable journal. Never operate on the live worktree.

**Done when:** traversal, symlink, command injection, dirty-base, resource exhaustion, cancellation,
restart, and cleanup tests pass without touching live or tenant paths.

### Task 28: Persistent Jarvis runtime and continuation

**Type:** integration / code
**Depends on:** Tasks 10 and 26
**Complexity:** complex

Attach the existing exact-agent conversations to a configured model/tool adapter with bounded turns,
budgets, continuation checkpoints, evidence citations, and explicit unsupported/degraded states.

**Done when:** the dashboard preserves conversations/restarts, tool calls stay within the exact
server-issued scope, cancellation works, and no hidden reasoning or raw secrets are persisted.

### Task 29: Change authoring, evaluation, and evidence

**Type:** code
**Depends on:** Tasks 27–28
**Complexity:** complex (Level 3)

Allow Jarvis to inspect its registered repository scope, draft a plan, edit only the isolated
workspace, run focused/full gates, dispatch independent review, and freeze a bounded diff/evidence
package.

**Done when:** failed or incomplete gates cannot become approval-ready; author and reviewer cannot
mint their own approval or release evidence.

### Task 30: Dashboard change-review workflow

**Type:** page / dashboard
**Depends on:** Tasks 25–29
**Complexity:** complex

Add conversation-to-change-request handoff, progress, bounded diff/test/review inspection, stale
fingerprint detection, exact approve/reject/cancel controls, and accessible desktop/mobile states.

**Done when:** the operator can interact with Jarvis throughout authoring and decide the exact frozen
change, with loopback/CSRF/auth boundaries and a clean browser console.

### Task 31: Approved branch application and rollback

**Type:** operations / code
**Depends on:** Tasks 21 and 30
**Complexity:** complex

Apply an approved frozen change only to its dedicated branch, create auditable commit evidence, and
hand it to the normal protected review/release path. Keep merge, trust mutation, and activation
separate.

**Done when:** stale base/diff/approval, merge conflict, changed tests, or changed policy requires a
new proposal; rollback is exact and retained.

### Task 32: Production acceptance and operator handoff

**Type:** verification / alignment / operations
**Depends on:** Tasks 22 and 31
**Complexity:** complex

Run the accelerated 14-slot fault campaign, live browser/security/accessibility checks, governed
self-edit golden path and negative matrix, signed start attestation, real 14-day run, signed end
attestation, recovery drill, and operator documentation.

**Done when:** every reliability requirement and governed-self-edit invariant has direct retained
evidence; 14/14 jobs are verified/finalized/notified; no P0/P1 or unresolved hold remains; and the
operator can converse, inspect, propose, approve, reject, cancel, recover, and roll back from the
dashboard without granting Jarvis self-approval or release authority.

## Immediate build batch

The first batch is Tasks 1–4. It is deliberately dormant: it establishes exact identities and the
candidate/hold boundary without activating schedules or changing production success semantics until
the complete pending-and-settlement path exists.
