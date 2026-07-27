# Faceless Content Studio — Build Tasks

> **Build result (2026-07-23):** Tasks 1–4 are complete in the isolated workflow. Eighteen focused
> tests and focused lint pass. Repository-wide typecheck remains blocked by concurrent
> `subscription-runtime`/dashboard work outside this workflow; no shared harness files were changed
> to mask that failure. The real account-link, provider, render, publish, analytics, and revenue
> states remain unverified external work.

## Task 1: Research and decision record

**Done criteria**

- Verify current YouTube, TikTok, and Higgsfield primary sources.
- Separate format eligibility from guaranteed monetization.
- Choose a proof-first content and provider strategy.

## Task 2: Behavioral contracts

**Depends on:** Task 1

**Done criteria**

- Write failing tests for all four lanes, proof promotion/hold, rights and likeness denial, strict
  input, disclosures, email-group privacy, cross-account variants, cloned-voice consent, publish
  intents, and exact worker tenant binding.
- Specify bounded Zod input/output contracts.

## Task 3: Deterministic planner and proof gate

**Depends on:** Task 2

**Done criteria**

- Implement target profiles, beat sheets, provider routing, workflow gates, scorecards, and
  compliance controls.
- Keep publishing blocked and unknown economics unknown.
- Select a manual Higgsfield manifest only after proof.

## Task 4: Jarvis worker

**Depends on:** Task 3

**Done criteria**

- Add a construction-bound `faceless-content` worker.
- Support plan, plan-account-links, compose-variants, and evaluate-pilot commands.
- Reject client/automation mismatch and unknown commands.
- Return JSON-compatible planner/evaluation evidence without external side effects.

## Task 5: Manual upload session planner

**Depends on:** Task 4

**Status:** complete (2026-07-23). Six focused tests cover ordering, budget deferral, rejection,
disclosure steps, duplicate-asset refusal, and worker routing.

**Done criteria**

- Add a `plan_upload_session` command producing per-account `sign in → upload → verify → sign out`
  blocks with platform-native checklists.
- Enforce the session time budget: defer overflow with a reason, never overrun.
- Reject items lacking final QC, rights clearance, a portfolio account, or truthful disclosures.
- Emit no credential, token, or `secretref:` in the session sheet.
- Publish the operator runbook and the staged scale-up roadmap.

## Task 6: Ease-of-life upgrades (Phase 1)

**Depends on:** Task 5, plus three completed real sessions with recorded friction notes

**Status:** in progress. The session-sheet export shipped (`npm run content:session` →
`src/content/faceless-session-cli.ts` + `src/content/upload-session-sheet.ts`, 12 focused tests,
worked example inputs under `examples/`). The remaining items wait on measured friction from real
sessions.

**Done criteria**

- [x] Render the session sheet as a single checkbox page, one screen per account block.
- [ ] Stage assets per session with digests verified against the queue before the hour starts.
- [ ] Produce a paste-ordered metadata pack per item.
- [ ] Add a completion-log CLI that records the public URL and schedules 24h/7d/30d checkpoints.
- [ ] Add a pre-flight command that prints what would be rejected, run the evening before.

## Task 7: Agentic upload (Phase 2)

**Depends on:** Task 6, the Phase 2 entry gate in [ROADMAP.md](./ROADMAP.md)

**Done criteria**

- Implement the unified-adapter publish path first; keep direct platform OAuth private-only until
  each platform audit passes.
- Bind every automated publish to an exact human-approved fingerprint: variant, asset digest,
  metadata digest, disclosure flags, and target account.
- Keep the manual session sheet fully runnable as the permanent fallback.

## Task 8: Paid quality upgrades (Phases 3–4)

**Depends on:** Task 7 and a passed pilot gate

**Done criteria**

- Add ElevenLabs narration only when the evidence points at narration, with an actual character-cost
  ledger and consent evidence for any cloned voice.
- Add Higgsfield only after the voice question is answered, as a reviewable manual manifest for hero
  shots.
- Change one paid variable at a time and record cost per published variant.

## Task 9: Verification and handoff

**Depends on:** Tasks 1–4

**Done criteria**

- Run the focused test during iteration.
- Run the complete repository release gate.
- Update status and record implementation discoveries without claiming a real pilot or revenue.
