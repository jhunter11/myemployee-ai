# Agent Archetype Generalization

## Problem Statement

`src/agents/profile-catalog.ts` hardcodes 34 profiles, each pinned to one sleeve (`sleeve: 'engineering'` → `agency:engineering`). `lifecycle: 'template'` is declared on 25 of them but **read by no code** — templates are singletons wearing a label. So a Developer pod cannot be pointed at a second sleeve, the blue/red/verify triad is retyped by hand per pod (Growth lacks a verifier; Delivery and Knowledge lack reviewers), and the schema caps the catalog at 100 — which 5 pods × 5 roles × N clients exceeds at N≈4.

## Proposed Solution

Split the catalog into three layers.

**1. Archetype layer (defined once).** The `relation` enum already _is_ the archetype set. Each archetype owns a domain-invariant framework: stage sequence, budget class, output-contract shape, escalation rule.

**2. Pod recipe layer (defined once per function).** A recipe names which archetypes compose it plus domain stage/output vocabulary — "Developer" = advisor + builder + reviewer + verifier under a specialist.

**3. Instance layer (minted per scope, not in the catalog).** Recipe + scope → concrete profiles with concrete sleeves, registered through the existing `RegisterControlScope`/`RegisterMemorySleeve`/`IssueAgentSleeveGrant` machinery, which already supports `client|company|project` kinds.

### Generalization verdict

| Archetype                                        | Existing instances                                                                                                               | Verdict                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| specialist, advisor, builder, reviewer, verifier | developer, architect, code-blue/red, release-verifier, idea-*, growth pod, workflow-mapper, curator, toolsmith, publisher, scout | **Generic.** Output is artifact + evidence — a pure function of the sleeve.     |
| root (jarvis)                                    | jarvis                                                                                                                           | **Singleton.** Validator hard-requires exactly one.                             |
| coordinator                                      | agency, mcp-x402                                                                                                                 | **Per-scope.** Durable identity holding cross-run scope state.                  |
| operator                                         | automation-worker, seller-operator                                                                                               | **Per-scope.** Shape generalizes; the gate predicate does not.                  |
| auditor                                          | settlement-auditor                                                                                                               | **Per-scope.** Reconciles an external ledger; the invariant is domain-specific. |
| advisor-to-coordinator                           | chief-of-staff                                                                                                                   | **Per-scope.** Its subject _is_ the coordinator's context.                      |

The line is not "management vs. work." It is **anything crossing the sleeve boundary**: management crosses upward (operator/human), operator crosses outward (the world), auditor crosses backward (external records). Their correctness is defined outside the sleeve, so they cannot be generic. Everything inward-facing can.

## Assumptions & Bets

We assume sleeve isolation stays the safety primitive and instances stay run-bounded. We bet 5 generic archetypes + ~7 recipes covers every future sleeve. Identity risk: we may be defending the existing 34-node tree because it renders well on the dashboard.

## Thinking Level

Level 4 — the boundary-crossing criterion is derived, not assumed; it predicts _why_ operator and auditor resist generalization, which "management is special" does not.

## Skill Dependencies

Zod schema refactor, per-scope grant issuance, catalog-drift detection under dynamic instances, dashboard projection of archetype vs. instance.

## Alternatives Considered

| Alternative                   | Why Rejected                                                    |
| ----------------------------- | --------------------------------------------------------------- |
| Keep hardcoding per sleeve    | Breaks the 100 cap; drift already visible in missing reviewers. |
| One omni-agent per sleeve     | Destroys blue/red separation and accountability.                |
| Make coordinators generic too | Durable scope state cannot be shared without leaking sleeves.   |

## Quadrant Coverage

| Quadrant         | Element                                     |
| ---------------- | ------------------------------------------- |
| Individual Outer | Archetype/recipe/instance modules           |
| Individual Inner | Boundary-crossing criterion                 |
| Collective Outer | Access-control registry, catalog validator  |
| Collective Inner | What operators approve when a pod is minted |

## Time Horizons

- **V1:** extract archetypes + recipes; regenerate the current 34 profiles identically (byte-stable catalog hash) — pure refactor, no behavior change.
- **V2:** runtime instantiation into per-scope sleeves; add missing reviewers/verifiers; Finance and Marketing recipes (neither exists today — Growth is sales, not marketing).
- **Not planned:** agent-created agents, cross-sleeve coordinators, generic operators.
