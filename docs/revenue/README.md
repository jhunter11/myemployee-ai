# First-Client Acquisition Pack

> **DO NOT SEND — `blocked_pending_operator_review`.** These are research notes and draft
> materials. Jarvis must not send a message, submit a form, place a call, create an invoice, or
> claim revenue from this pack.

This pack covers the **Daily Lead Triage Pilot only**. Demand research on 2026-07-21 rejected that
offer as the commercial cash wedge; preserve the pack as a bounded engineering proof and historical
acquisition artifact. The current commercial decision is in
[demand-led-pivot.md](./demand-led-pivot.md). The broader Company Intelligence implementation path
remains in [agency-launch-roadmap.md](./agency-launch-roadmap.md), but it is not the first-dollar
offer.

## Outcome

This pack reduces the next commercial step to a human-reviewed conversation with one plausible
buyer. It does not manufacture demand or pretend that public fit signals prove a pain point.

The initial segment is **independent residential roofing contractors in the Charlotte metro**. The
offer is a bounded Daily Lead Triage Pilot: one daily CSV export enters a client-only compartment,
fixed rules identify qualified rows, and a reviewable brief plus run evidence comes out. The
existing `acme_corp/daily-report` path proves that shape with synthetic data.

## Operator path

1. Read [offer-and-qualification.md](./offer-and-qualification.md) and reject the segment if its
   assumptions do not survive discovery.
2. Pick one business from [first-client-pack.json](./first-client-pack.json); re-open every source
   URL and confirm that the business and contact channel are current.
3. Run the synthetic proof in [demo-runbook.md](./demo-runbook.md). Do not load prospect or client
   data for a first demonstration.
4. Use the discovery rubric. Proceed only with a real workflow, an export path, budget, and decision
   authority.
5. Choose one draft from [outreach-drafts.md](./outreach-drafts.md), personalize only with verified
   public business facts, and complete the compliance checklist.
6. Review the exact recipient, channel, subject, body, sender identity, and evidence. Record a human
   approval for **one** message. Sending remains a separate manual action.
7. If interest is real, use [objections-and-acceptance.md](./objections-and-acceptance.md) to scope a
   reversible first month and sign acceptance criteria before handling client data.

## Contents

- `demand-led-pivot.md` — the current demand decision, product portfolio, kill criteria, factorable
  reconciliation design, conversation guide, and 30-day evidence plan.
- `agency-launch-roadmap.md` — the current dual-track launch sequence, evidence snapshot, product
  gates, outreach strategy, and weekly scorecard.
- `company-intelligence/PLAN.md` — the retrieval-first product decision and V1/V2 boundaries.
- `company-intelligence/PILOT.md` — the audit and pilot offer, security contract, evaluation plan,
  discovery questions, pricing inputs, and stop conditions.
- `task-market/PLAN.md` and `task-market/SPEC.md` — the deterministic x402/MCP seller, read-only
  downtime scout, exact marketplace-write approvals, settlement accounting, and isolated VPS
  boundary. These do not authorize a wallet, submission, public deployment, or revenue claim.
- `first-client-readiness.md` — the evidence-backed readiness decision, remaining human actions,
  unattended-operation boundary, and x402/MCP promotion gate for Daily Lead Triage.
- `first-client-pack.json` — machine-readable offer, exact integer micro-USD pricing, ten public
  business candidates, provenance, and the no-send gate.
- `offer-and-qualification.md` — offer boundaries, pricing, qualification and discovery rubric.
- `outreach-drafts.md` — three channel-specific drafts and the mandatory review gate.
- `demo-runbook.md` — a truthful synthetic demo and a signed-pilot delivery runbook.
- `objections-and-acceptance.md` — honest objection responses, acceptance criteria, and stop rules.
- `provenance.md` — official public-business sources and research limitations.

## Evidence labels

- `research_only` means the business has public signals that make discovery reasonable.
- `qualified` requires a completed discovery rubric; none of the candidates is qualified yet.
- `proposal_ready` requires agreed acceptance criteria and a reviewed commercial scope.
- `won` or revenue requires a real signed agreement and verified payment evidence. This pack has
  neither.

The prospect records intentionally contain business labels and public website URLs only. They do
not contain personal names, scraped email addresses, telephone numbers, homeowner data, or inferred
technology stacks.
