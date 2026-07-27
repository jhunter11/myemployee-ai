# BUILD STATE — Agent Archetype Generalization V2

> **Resume file.** If a session is cut off, read this top-to-bottom and continue at the first
> unchecked task. V1's resume file is `2026-07-25-archetype-build-state.md`; design rationale is
> `2026-07-25-agent-archetype-generalization.md`.

## What changed between V1 and V2

V1 was a **pure refactor** governed by a frozen catalog digest. V2 is the opposite: it
**deliberately changes the catalog**, so the V1 digest is retired on purpose.

```
V1 BASELINE (retired): 34 profiles, sha256 80520874cc872b3f54b136a8e843638828921ae19533d039fd30345f2715676c
V2 BASELINE:           47 profiles, sha256 <filled in by task 5>
```

The stability test stays — its job changes from "never let this move" to "never let this move
_by accident_". Re-baselining is legitimate only inside a change that intends to alter the
catalog, and only together with the dependent count assertions listed in task 5.

**Check the digest any time:**

```bash
npx tsx -e "import{createHash}from'node:crypto';import{listAgentProfiles}from'./src/agents/profile-catalog';const p=listAgentProfiles();console.log(p.length,createHash('sha256').update(JSON.stringify(p),'utf8').digest('hex'))"
```

## The V2 thesis

V1 proved the archetype/recipe split reproduces the catalog. V2 asks the question that split was
built to answer: **can a pod be pointed at a sleeve chosen at runtime?**

The answer falls straight out of the boundary-crossing criterion: a recipe is instantiable iff
**every** member's archetype is generalizable. One boundary-crossing member (root, coordinator,
operator, auditor) poisons the whole pod, because that member's correctness is defined outside
the sleeve and cannot be re-bound by changing the sleeve.

Expected split (verify in task 7, do not assume):

| Instantiable                                                                | Not instantiable | Blocked by  |
| --------------------------------------------------------------------------- | ---------------- | ----------- |
| developer, idea, growth, knowledge, finance, marketing, contracts, scouting | jarvis           | root        |
|                                                                             | agency, mcp-x402 | coordinator |
|                                                                             | delivery, seller | operator    |
|                                                                             | settlement       | auditor     |

## Safety invariants that must survive V2

Carried from the catalog validator and SPEC §24. None of these may be relaxed:

- No `task_market` profile receives `execute` access, wallet material, or signing authority.
- **Static** profiles may never bootstrap `client:` sleeve access. V2 does not weaken this — the
  instance path is the "separately authorized temporary grant" the validator's error message
  already refers to, and it runs through a different code path with an operator gate.
- Instances are minted at `authorityLayer: 'operator'` with a real expiry, never `blueprint`.
- **No instance may hold `execute`.** Outward effect belongs to the `operator` archetype, which is
  not generalizable, so no instantiable pod contains one. This is enforced, not merely true today.
- The 100-profile catalog cap **stays**. Instances live in the access-control plane, not in
  `listAgentProfiles()`, so they do not consume it. (V1's resume file wrongly listed raising the
  cap as V2 work — corrected here.)

## Tasks

- [ ] **1. SPEC §24 first.** Adding profiles is spec drift: §24 pins the seeded tree and the
      durable-coordinator list. Update the tree, the durable sentence, and add a
      "Pod recipes and scoped instances" subsection. Spec before code.
- [ ] **2. Regularize sleeve derivation.** Verifier `sleeveRule` `'explicit'` → `'pod_reviews'`;
      drop `'explicit'` from `SleeveRuleSchema`; **delete `PodMember.sleeve` entirely**. After
      this, a sleeve is a pure function of (pod, archetype) with no escape hatch. Renames:
      `contract_reviews`→`contracts_reviews`, `security_reviews`→`seller_reviews`,
      `submission_reviews`→`scouting_reviews`, evaluation-runner `improvement`→`knowledge_reviews`,
      toolsmith `improvement`→`knowledge`. `agency:improvement` disappears.
- [ ] **3. Missing triad members** (+3): `agency-growth-verifier`, `agency-delivery-red`,
      `agency-knowledge-red`.
- [ ] **4. Finance and Marketing pods** (+10). Agency domain, 5 members each
      (specialist/advisor/builder/reviewer/verifier). Only already-allowlisted agency tool
      namespaces — if either pod needs a new namespace, stop and reconsider the pod, do not widen
      `TOOL_NAMESPACES`. Neither pod gets an operator: drafting is inward, publishing is not.
- [ ] **5. Re-baseline.** Regenerate `tests/agents/__fixtures__/catalog-baseline.json`, update
      `BASELINE_SHA256` and rewrite the test's header comment. Dependent assertions to update:
      `profile-catalog.test.ts` (length 34→47, id list, durable list),
      `profile-access-bootstrap.test.ts` (`profileCount`, `knowledgeScopeCount`, `sleeveCount`,
      `sleeveGrantCount`, `toolGrantCount`).
- [ ] **6. Stale blueprint-grant reconciliation.** Task 2 renames sleeves, which leaves active
      blueprint grants that no longer appear in the manifest, so `ProfileAccessBootstrap.install()`
      would throw `CATALOG_ACCESS_DRIFT` against an existing database. Revoke active blueprint
      grants for catalog agents that are absent from the manifest, before the drift check.
      Without this, V2 bricks any already-bootstrapped DB.
- [ ] **7. `src/agents/pod-instances.ts`** — pure planner. `planPodInstance()` returns profiles,
      control scope, knowledge scope, sleeves, and grants without touching the database.
- [ ] **8. `PodInstanceInstaller`** — operator-gated write path.
- [ ] **9. `tests/agents/pod-instances.test.ts`** — instantiable set, all three binding kinds,
      every fail-closed path.
- [ ] **10. Full verify** — `typecheck && test && lint && format:check && build`.

## Ordering rule

Tasks 2–4 all change the digest, so the stability test is red between task 2 and task 5. That is
expected; do not "fix" it early by re-baselining before task 4 lands. Tasks 7–9 are additive and
independent of 2–6 — if a session dies mid-way, they can be started from a clean tree.

## Non-obvious constraints discovered while planning

- **Agent ids cannot hold underscores** (`AgentIdSchema` = `^[a-z][a-z0-9-]{2,63}$`) but
  **client sleeves cannot hold hyphens** (`^client:[a-z][a-z0-9_]{2,62}$`). An instance binding
  carries one `subjectId` in underscore form and converts to hyphens for agent ids.
- **Instances cannot use `AgentProfileCatalogSchema`.** It requires exactly one root, forbids
  `client:` sleeves, and requires every sleeve to be prefixed by the trust domain. Instances use
  `AgentProfileSchema` plus their own validator. This is a feature: the static-catalog rules stay
  untouched.
- **Knowledge scopes only have `harness|project|client` kinds**, but control scopes have
  `company|client|project`. Mapping: client → `client:<subject>`, company →
  `project:company_<subject>`, project → `project:project_<subject>`. The kind is always
  recoverable, so two bindings of different kinds can never collide on one knowledge scope.
- Reviewers cannot read the sleeve they critique — that is intentional. Inputs arrive as pinned
  artifact digests (`*_pinned` opening stage), not as sleeve reads. Do not "fix" it.

## Known drift explicitly NOT addressed in V2

- `lifecycle: 'template'` is still read by no code in `src/`. It is descriptive metadata on the
  dashboard only. Removing it is a separate change with its own digest churn.
- Pods are still not uniform: `growth` has two builders and no advisor, `contracts` has no lead
  specialist (its builder is the lead), `agency` has only an advisor. Uniformity is not a goal —
  the archetype layer enforces safety, not symmetry.
