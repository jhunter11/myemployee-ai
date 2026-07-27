# Memory Architecture Experiment Program

**Date:** 2026-07-24 (revised 2026-07-25)
**Status:** Proof of concept complete and runnable. Ledger, temporal, and experiment
layers landed. The bench **runner** is unfinished — see Honest limitations.
**Sources:** three deep-research reports on agentic memory architecture

## Why

Three research reports were assessed against Jarvis's memory system:

| Report                             | Subject                                                 | Prior state in Jarvis                                |
| ---------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| (3) Agentic memory architectures   | CoALA typed-hybrid memory cell per sleeve               | ~90% built by prior work (`023_typed_hybrid_memory`) |
| (2) Deterministic memory semantics | Event-sourced ledger, bitemporality, conflict hierarchy | Not built                                            |
| (4) Experimental program           | 8 arms, workload generator, metric dictionary, gates    | Partial (2-arm retrieval eval only)                  |

The reports agree on one methodological point above all others: **test instead of
guessing**. No single memory architecture dominates all workloads, so the deliverable
is not "the best architecture" but a harness that can measure candidates against each
other on the workloads Jarvis actually has.

## The finding that shaped the design

Jarvis's `flat` backend is **already stronger than the literature's flat baseline**.
`ScopedLexicalRetrievalService` filters superseded revisions, closed validity windows,
and operator-withdrawn fragments in SQL, before ranking.

That is good engineering, but it makes the reports' central hypothesis — _typed and
temporal memory beats flat tagged memory_ — untestable as written, because the flat arm
already contains the temporal behaviour under test. Comparing `flat` against
`typed_hybrid` therefore shows no difference, and it would be easy to misread that as
"the typed work bought us nothing."

The fix is an explicit experimental control, `flat_untyped`, which restores the
literature baseline: tags and lexical ranking, no temporal reasoning. It relaxes
**temporal correctness only** — scope binding and the sensitivity ceiling are enforced
exactly as everywhere else, so the control isolates one variable and stays safe to run.

## Backends

Five interchangeable backends behind one `MemorySystem` seam, selected by
`createMemorySystem({ backend })` or `JARVIS_MEMORY_BACKEND`. Default stays `flat`.

| Backend          | Role                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| `flat_untyped`   | **Experimental control only.** Returns stale facts by design. Never for production. |
| `flat`           | Current production default: one store, temporally-filtered lexical retrieval        |
| `typed_hybrid`   | CoALA store classes, working memory, propose-only consolidation                     |
| `typed_temporal` | `typed_hybrid` + validity-window reasoning and stale suppression                    |
| `ledger`         | Event-sourced revisions, bitemporal semantics, deterministic projections            |

## Proof of concept

`npm run memory:demo`

A hand-authored 11-item corpus (`src/memory/demo/sample-memory.ts`) and 5 probe
questions. Where the synthetic generator produces volume, this corpus produces
**legibility**: every item declares the role it plays, so a trace can explain not just
what was retrieved but why that was right or wrong.

The corpus deliberately contains a superseded launch date, a policy whose validity
window closed, an operator-withdrawn fragment, a lexical distractor, an evidence chain
for multi-hop questions, and a near-identical fact in a neighbouring client sleeve that
must never appear.

Each answer produces a reasoning trace:

```
  1. authorize  -> read grant on client:acme_corp (deny-first; other sleeves unreadable)
  2. retrieve   -> terms [when, does, the, acme, relaunch, ship]
       [1] acme-launch-date-v2 (semantic) bm25=-2.029
  3. suppress   -> 3 candidate(s) held back
       - acme-launch-date-v1: suppressed: a newer revision supersedes it
  4. compile    -> ready, 115/760 evidence tokens used
  5. resolve    -> answered
       policy: query_specificity_coverage_confidence_v1 (evidence_threshold_met)
       best match: acme-launch-date-v2 coverage=1000/1000 confidence=900/1000
       cites: acme-launch-date-v2
  MEMORY: correct    ANSWER: correct
```

### Two-layer scoring

Correctness is scored at two independent layers, because conflating them is the mistake
the reports warn about most:

- **memory layer** — did retrieval surface what was required and hold back the stale,
  withdrawn, and out-of-scope items? This is the backend's job and what a comparison measures.
- **answer layer** — did the fixed, model-free resolver reach the right conclusion? It
  considers only compiled survivors, ranks meaningful exact-query coverage discounted by
  fragment confidence, and requires fixed 600/1000 coverage and confidence floors. The resolver
  is held constant across backends, so a difference here is downstream of a memory difference,
  never a backend's doing.

### Measured result

```
backend         memory    answer    abstain   leaks   behaviour  safety
-----------------------------------------------------------------------
flat_untyped    2/5       3/5       0/2       3       A          FAIL (forbidden evidence surfaced)
flat            5/5       5/5       2/2       0       B          pass
typed_hybrid    5/5       5/5       2/2       0       C          pass
typed_temporal  5/5       5/5       2/2       0       C          pass
ledger          5/5       5/5       2/2       0       B          pass
```

The **behaviour** column groups backends by a digest of what they actually did,
with the backend's own name excluded from the hash. It exists because equal scores
are not evidence of equal behaviour, and the original scoreboard could not tell the
two apart. It reports three distinct groups where five rows previously looked
interchangeable:

- **B** — `ledger` decides identically to `flat`. Expected: it writes through the
  reducer and reads over the flat substrate. Now assertable rather than assumed.
- **C** — the typed arms re-rank by store class and genuinely diverge from `flat`.
- `typed_temporal` matches `typed_hybrid` **on this corpus only**, because the
  substrate SQL already filters every temporal case the 11 items contain. The
  temporal layer is exercised by `tests/memory/system/temporal-retrieval.test.ts`,
  not by this demo.

Two real findings fall out immediately:

1. **Defense in depth is working.** On the launch-date question the control ranks the
   _stale_ Sept 15 date first (bm25 −2.061, a better lexical match than the current
   −2.029) — a textbook ghost-memory failure. It suppresses nothing. But the context
   compiler still drops the superseded revision, so the final answer stays correct.
   Memory fails, the answer survives, and the two-layer scoring makes that visible
   rather than hiding it behind a passing end-to-end score.

2. **Abstention and evidence selection were the measured weak point, and the demo fix moves
   the metric.** Before the resolver policy, the safe backends scored 5/5 on memory but 2/5
   on answers: code-freeze and refund-policy over-answered, while release-checklist cited the
   short brand-palette fragment because compiler utility order was mistaken for answer rank.
   `query_specificity_coverage_confidence_v1` now re-ranks only compiled survivors, requires at
   least two meaningful query terms, and declines weak or low-confidence evidence. Safe backends
   score 5/5 answers and 2/2 expected abstentions with zero leaks. This is still a five-question
   behavioral proof, not a production-calibrated threshold.

## Determinism

Every layer is deterministic and fingerprinted: frozen demo clock, seeded PRNG (no
`Math.random`), stable tie-breaks (`score desc, id asc`), temp databases per backend so
no arm benefits from another's writes. Re-running the demo produces byte-identical
traces, and the tests assert it.

## Invariants preserved

1. No new cross-sleeve movement. Promotion still requires `shared_approved_bundles`.
2. The control relaxes temporal correctness only, never scope or sensitivity.
3. Working memory stays run-local; candidate stores stay propose-only.
4. Default backend remains `flat`; every addition is opt-in.

## Defects found by review, and fixed

An adversarial review ran four lenses over the build. Seven findings were confirmed
by direct inspection; each fix carries a regression test that fails without it.

| Defect                                                                                                              | Why it mattered                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `arms.ts` claimed TypedBasic switched per-store retrieval on; `typed_hybrid.retrieve` was byte-identical to `flat`  | The FlatTag→TypedBasic contrast — the program's first hypothesis — could only ever measure noise. Fixed in the backend.  |
| `isRetrievable` encoded the abstain-on-conflict rule and was called from nowhere; reads used `isLiveClaim`          | Both sides of an unresolved contradiction were served as current, silently picking a winner the ledger never decided.    |
| `handleSplit` conflict-checked parts against pre-command state only                                                 | One SPLIT could commit two contradictory active claims with no conflict flag and no contradiction edge.                  |
| `DeterministicPrng.fromSeed` stored its label without mixing it into the seed                                       | Two "independent" root streams at one seed emitted identical sequences; any cross-component effect would be an artifact. |
| `deletionQueue` was never restored by `loadState`, and the test copied the value out of the object under comparison | The erasure obligation vanished on restart, and the tautological assertion could not fail.                               |
| `localeCompare` ordered the seeded cluster bootstrap and the arm ranking                                            | Host-collation-dependent ordering: the same seed could yield different confidence intervals on a different machine.      |
| The trace fingerprint hashed the backend id                                                                         | Two backends always differed there, so it could not support the cross-backend comparison it appeared to.                 |

One reported defect did **not** survive checking: a payload nested past the
canonicalizer's depth cap is rejected by the zod payload union first, so the audit
already happened. The reducer's `try/catch` was kept as defence in depth and is
documented as such rather than as a fix.

## Honest limitations

- **The bench runner is unfinished.** `src/memory/experiment/bench-runner.ts` has the
  per-item replay machinery but no top-level orchestrator, no CLI, and no tests; two
  agents died mid-file on session limits. Its `metrics` field is now typed
  `MetricBundle | null` and set to `null` — previously a `{} as MetricBundle` cast
  asserted a bundle that was never computed. Nothing consumes it yet, so nothing is
  currently reporting fabricated numbers, and the honest type is what keeps that true.
- **The bench measures no consolidation cost.** The replay harness runs no
  consolidation pass, so `consolidationProposals` is structurally zero. An arm whose
  policy declares consolidation would have its maintenance cost understated, and must
  be skipped rather than scored until that pass exists.
- **Nothing in the running app consumes the memory seam yet.** `createMemorySystem` is
  called only from the demo, the bench, and tests — no gateway, chat, or agent path
  binds it. Backends are swappable in code, via `--backends`, and now via
  `JARVIS_MEMORY_BACKEND`; but "Jarvis's memory is swappable" is not yet true, only
  "a swappable memory seam exists and is tested".
- The demo resolver is a fixed model-free stand-in, not a language model. It exists to
  hold the answer stage constant. Its 600/1000 thresholds need a larger frozen golden set
  before reuse outside this demo.
- The 11-item corpus proves behaviour, not statistics. Volume comes from the synthetic
  workload generator, once the runner that drives it exists.
