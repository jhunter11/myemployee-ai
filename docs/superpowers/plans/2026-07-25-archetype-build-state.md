# BUILD STATE — Agent Archetype Generalization V1

> **Resume file.** If a session is cut off, read this top-to-bottom and continue at the first
> unchecked task. Design rationale lives in `2026-07-25-agent-archetype-generalization.md`.

## The one invariant that governs this build

V1 is a **pure refactor**. The generated catalog must stay byte-identical.

```
BASELINE: 34 profiles
sha256(JSON.stringify(listAgentProfiles())) = 80520874cc872b3f54b136a8e843638828921ae19533d039fd30345f2715676c
```

Golden fixture: `tests/agents/__fixtures__/catalog-baseline.json` (task 1).
If the hash changes, the refactor is wrong — not the hash. Never edit the expected hash.

**Check it any time:**

```bash
npx tsx -e "import{createHash}from'node:crypto';import{listAgentProfiles}from'./src/agents/profile-catalog';console.log(createHash('sha256').update(JSON.stringify(listAgentProfiles()),'utf8').digest('hex'))"
```

## Empirical findings that justify the factoring

Measured against the baseline (do not re-derive; these are settled):

| Invariant                                                        | Conformance                                        | Enforceable?                          |
| ---------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| `escalation.target === parentId`; root → `operator`              | 34/34                                              | **Yes — hard rule**                   |
| reviewer/verifier/auditor stages are `*_pinned … *_published`    | 12/12                                              | **Yes — hard rule**                   |
| reviewer sleeve ends in `_reviews`                               | 4/4                                                | **Yes — hard rule**                   |
| reviewer sleeve stem === pod sleeve                              | **3/4** — `contracts` pod → `contract_reviews`     | No — default with explicit override   |
| child `trustDomain` === parent's (except jarvis→agency/mcp-x402) | 34/34                                              | Already enforced in catalog validator |
| budget class derivable from relation                             | **No** — advisor 2, builder 3, verifier 3 distinct | No — allowlist per relation instead   |
| stage sequence derivable from relation                           | **No** — 34/34 distinct                            | No — middle stages stay hand-authored |

**Conclusion:** archetypes own _structure and safety invariants_; recipes own _composition_;
seeds own _domain content_. Anything claiming more than this is over-reach — stages are genuinely
per-profile and must stay that way.

Boundary-crossing archetypes (root, coordinator, operator) have idiosyncratic stage shapes
because their stages track external state. This is why they resist generalization — the same
reason given in the design plan, now confirmed by measurement.

## Target module structure

```
src/agents/archetypes.ts      NEW  — 9 ArchetypeSpecs + assertArchetypeConformance()
src/agents/pod-recipes.ts     NEW  — PodRecipe type + the 9 pod definitions + expandRecipe()
src/agents/profile-catalog.ts EDIT — seeds generated from recipes; PUBLIC API UNCHANGED
```

**Public API that must not change** (consumers: `agent-conversation-service.ts`,
`profile-access-bootstrap.ts`, 3 test files):
`AgentProfileSchema`, `AgentProfileCatalogSchema`, `AgentSleeveIdSchema`, `AgentTrustDomainSchema`,
`AgentRuntimeModeSchema`, `AgentLifecycleSchema`, `AgentRelationSchema`, `AgentToolGrantSchema`,
`validateAgentProfiles`, `listAgentProfiles`, `findAgentProfile`, `projectAgentHierarchy`,
and all exported types.

## Status: V1 COMPLETE (2026-07-25)

All 7 tasks landed. 34 profiles now generated from 12 pod recipes; catalog digest unchanged at
`80520874…5676c`. Full suite green: 2107 tests / 195 files, typecheck, lint, format, build.

## Tasks

- [x] **1. Golden fixture** — write `tests/agents/__fixtures__/catalog-baseline.json` from the
      current catalog; add `tests/agents/catalog-stability.test.ts` asserting deep-equality AND the
      sha256 above. **This test must pass before any refactor and after every task.**
- [x] **2. `archetypes.ts`** — `ArchetypeSpec` per relation: `budgetKinds` (allowlist),
      `defaultBudget`, `stageBookend` (`null` for boundary-crossing kinds),
      `sleeveRule` (`'domain'` | `'domain_reviews'`), `escalatesTo` (`'parent'` | `'operator'`),
      `generalizable: boolean`. Export `assertArchetypeConformance(profile)` enforcing the 3 hard
      rules above.
- [x] **3. `pod-recipes.ts`** — `PodRecipe` + `PodMember`. Recipe supplies pod id, trust domain,
      domain sleeve, lead, and members. `expandRecipe()` derives: `parentId`, `escalationTarget`,
      sleeve (via `sleeveRule`), budget (member override else archetype default).
      Domain content (purpose, tools, stages, outputFields, completionCriteria,
      escalationConditions, evidenceRefs, artifactType) is carried verbatim from the member.
- [x] **4. Port all 34 profiles** into recipes. 9 pods: `jarvis` (root, standalone),
      `agency` + 5 sub-pods (chief-of-staff, developer, idea, growth, delivery, knowledge),
      `mcp-x402` + 4 sub-pods (publisher, seller, scout, settlement).
      **Port in pod-sized batches, running task 1's test after each batch.**
- [x] **5. Wire `profile-catalog.ts`** to build `PROFILE_SEEDS` from recipes. Delete the literal
      seed array. Keep `makeProfile`, schemas, and all exports byte-identical in behavior.
- [x] **6. Conformance tests** — `tests/agents/archetypes.test.ts`: every profile passes
      `assertArchetypeConformance`; the 5 generalizable archetypes are marked generalizable;
      root/coordinator/operator/auditor are not.
- [x] **7. Full verify** — `npm run typecheck && npm test && npm run lint && npm run format:check`.
      Catalog hash unchanged. `ProfileAccessBootstrap` still reports the same `catalogSha256`.

## Ordering rule

Tasks 2 and 3 are additive (new files, nothing imports them) — safe to land independently.
Task 5 is the only breaking edit. Do not start task 5 until task 4 is fully ported, because
`profile-catalog.ts` has no working intermediate state between "literal seeds" and "recipe seeds".

## Known drift to NOT fix in V1

These are real gaps found during analysis. Fixing them changes the hash, so they are **V2**:

- `agency-growth` has no verifier (every other pod has one)
- `agency-delivery` and `agency-knowledge-improvement` have no reviewer
- `agency-evaluation-runner` is a verifier writing to `agency:improvement`, not `*_reviews`
- `mcp-x402-contract-red-team` writes to `contract_reviews` while its pod sleeve is `contracts`
  — the only reviewer needing an explicit sleeve. Renaming it to `contracts_reviews` would let
  the archetype derive it, but changes the digest
- Verifier sleeves are irregular enough (`security_reviews` under the `seller` pod,
  `submission_reviews` under `scouting`) that the archetype uses the `explicit` rule rather than
  deriving. Regularising them is a V2 rename
- No Finance pod exists; `agency-growth` is sales, not marketing

V1 records each of these as an explicit member-level override rather than silently normalising
them, so every irregularity stays visible in `pod-recipes.ts` instead of hiding in prose.
Record them; do not act on them.

## Where the layers live now

- `assertArchetypeConformance` runs inside `validateAgentProfiles`, **after** the zod parse — so
  existing catalog-schema errors keep reporting first (`profile-catalog.test.ts` depends on this
  ordering for its `reviewed-handoff` assertion).
- `expandRecipe` is exported from `profile-catalog.ts`, not `pod-recipes.ts`, because `ProfileSeed`
  lives there. `pod-recipes.ts` stays pure data + types, so its only imports are type-only and
  there is no runtime import cycle.
