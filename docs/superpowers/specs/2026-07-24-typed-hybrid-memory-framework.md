# Interchangeable Typed-Hybrid Memory Framework

**Date:** 2026-07-24
**Status:** Built (default-off, additive), pending operator adoption

## Why

A deep-research report on agentic memory architectures was assessed against Jarvis's
existing scoped-memory system. Finding: Jarvis already implements ~80% of the report's
recommended "typed hybrid memory cell per sleeve" baseline. The one real gap is that the
`memory_kind` axis is **passive** — all ten kinds live in one `memory_fragments` table
behind one BM25 retrieval path, with no per-store write rules, retrieval policy, retention,
or consolidation.

This framework activates the kind axis as an **interchangeable backend**, mirroring the
model-provider seam (`src/models/contracts.ts` + `factory.ts`). It is additive and
default-off: the flat substrate stays authoritative; no existing memory is migrated.

## What Jarvis already had (unchanged)

| Capability                                                            | Location                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Deny-first scope/sleeve isolation, versioned, no-delete               | `src/db/migrations/010_access_control_sleeves.sql`                                           |
| Typed kinds (CoALA taxonomy) + temporal windows + supersession        | `src/db/migrations/011_scoped_lexical_retrieval.sql`, `src/knowledge/retrieval-contracts.ts` |
| Authorized BM25 retrieval with selected/omitted manifest              | `src/knowledge/lexical-retrieval-service.ts`                                                 |
| Operator-gated cross-sleeve promotion (sanitized, provenance, expiry) | `shared_approved_bundles` in `010`, `src/agents/access-control-contracts.ts`                 |
| Deterministic context budgeting (reserves working-state)              | `src/knowledge/context-compiler.ts`                                                          |
| Retrieval eval harness (recall/MRR/leakage/abstention)                | `src/knowledge/retrieval-evaluation.ts`                                                      |
| Propose-only memory curator profile                                   | `agency-memory-curator` in `src/agents/profile-catalog.ts`                                   |

## What this framework adds

New module: `src/memory/system/`.

- **`MemorySystem` seam** (`contracts.ts`) — uniform `write` / `retrieve` / `compileContext`
  plus null-able capability accessors `workingMemory()` / `consolidation()` / `procedures()`.
- **Backend A `flat-lexical-system.ts`** — wraps the existing services with zero behavior
  change; capability accessors return `null`.
- **Backend B `typed-hybrid-system.ts`** — keeps `memory_fragments` as the durable
  episodic/semantic/procedural substrate and adds three active stores (migration `023`):
  - `working_memory` — run-local, immutable+supersedable, reads strictly bound to
    `(owner_scope_id, sleeve_id, run_id)`, never promoted.
  - `memory_consolidation_candidates` — propose-only episodic→semantic/procedural
    distillations with provenance, temporal state, and validity.
  - `memory_procedure_candidates` — propose-only repeated-workflow (Voyager-style) skills,
    signature-checked against their steps.
  - `retrieve()` — deterministic per-store re-ranking over the substrate-authorized candidate
    set. It never widens the set and rebuilds the audited selected ranks/fingerprint.
- **`store-classes.ts`** — the kind→store-class mapping and per-store policy (write rule,
  retention, FTS weights, consolidation role).
- **`consolidation-planner.ts`** — a **pure, deterministic** planner (the pipeline behind
  `agency-memory-curator`) that scans episodic evidence + observed workflows and emits
  **propose-only** candidates, plus a thin `MemoryConsolidationRunner`.
- **`eval-harness.ts`** — multi-backend A/B comparison (`evaluateMemoryBackends`,
  leakage-first ranking) + `evaluatePromotionPrecision` (bank-maintenance layer).
- **`factory.ts`** — `createMemorySystem({ sqlite, access, backend })`, default `flat`;
  `resolveMemoryBackendFromEnv` reads `JARVIS_MEMORY_BACKEND`, defaulting safely to `flat`.

## Invariants preserved

1. **No new cross-sleeve movement in authorized retrieval or materialized fragments.**
   Cross-sleeve promotion still requires the operator-reviewed `shared_approved_bundles` path.
   Candidate rows remain inert and propose-only, but their claimed source sleeves are not yet
   repository-verified; that governance gap blocks unattended scheduling and materialization.
2. **Working memory is run-local and never auto-promoted.**
3. **Candidate stores are propose-only** — writing a candidate never mutates durable
   `memory_fragments` and never auto-supersedes. Materialization stays operator-gated.
4. **Immutable content + one-time supersession** enforced by SQLite guard triggers, matching
   the `memory_fragments` discipline (immutable binding, no-delete, active-sleeve binding).
5. **Sensitivity caps** are enforced for durable fragments and working memory. Candidate-store
   cap/provenance/proposer enforcement remains a live-pilot prerequisite (see limitations).
6. **Determinism** — the planner and evaluators are pure; identical inputs → identical
   outputs (stable ids, ordering, fingerprints).

## Honest limitations / deferred

- Per-store reweighting is wired, but it has passed only the small demo/behavior suite. Promotion
  still requires the frozen Jarvis/faceless golden set in SPEC §21.
- The planner emits **deterministic** semantic `summary` candidates (digests, not LLM
  syntheses) and procedural candidates. An LLM-backed planner can later produce
  fact/preference/policy candidates through the same propose-only channel.
- Candidate source IDs are schema-declared but not yet repository-verified for existence,
  liveness, episodic kind, exact sleeve, or sensitivity derivation. Candidate operations are not
  yet bound to the proposing principal. Do not schedule or auto-approve them unattended.
- No approve/reject/apply lifecycle or atomic candidate-to-fragment materialization receipt exists.
- Nothing in the running gateway/chat/agent/worker app consumes `MemorySystem`; current callers are
  demo/experiment scaffolding and tests.
- No data migration; flat remains the default and authoritative store.
- A graph/temporal overlay (A-MEM / MRAgent style) is intentionally NOT built — the report
  advises adding it only if the eval harness shows the typed baseline failing on multi-hop
  or deep-temporal recall.

## Turning it on

```bash
# select typed_hybrid for an explicit seam consumer (the live app is not wired yet)
JARVIS_MEMORY_BACKEND=typed_hybrid
```

Or explicitly: `createMemorySystem({ sqlite, access, backend: 'typed_hybrid' })`.

Before flipping the default, run both backends through the same golden fixture with
`evaluateMemoryBackends` (shadow phase) and require zero scope leakage plus non-regressed
recall/temporal correctness — the report's "test instead of guessing" gate.

## Tests

`tests/memory/system/` — store-class mapping, per-store reranking, contract refinements, both backends,
working-memory run isolation/expiry/supersession, propose-only immutability + conflict,
planner determinism + thresholds + runner fail-closed on flat, factory selection, and the
eval harness. Full suite green; migration `023` added to both packaging manifests.
