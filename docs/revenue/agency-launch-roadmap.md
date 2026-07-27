# AI Agency Launch Roadmap

**As of:** 2026-07-21

> **Commercial supersession:** [demand-led-pivot.md](./demand-led-pivot.md) is the authoritative
> first-dollar decision. The Daily Lead Triage Pilot is paused after demand research rejected its
> volume, value ceiling, export burden, substitution resistance, and actionability. Preserve its
> implementation as a synthetic proof. Company Intelligence remains a separate, slower flagship
> hypothesis.

## Decision

Run a demand-led sequence without confusing research plausibility with proof:

1. **Cash-wedge test — Retainer Margin Reset:** sell and manually deliver a paid-on-delivery audit to
   a strictly qualified split-stack professional-services firm before building a platform.
2. **Validation queue:** staffing paid-vs-billed hours, accounting repricing evidence, and supplier
   rebate recovery remain interview or paid-test hypotheses.
3. **Flagship — Company Intelligence Assistant:** retain the implementation plan, but park product
   build and enterprise selling until the first commercial wedge has real evidence or a warm design
   partner requests the bounded knowledge audit.

x402/custom MCP remains a separate simulation track and must not block agency acquisition.

## Current evidence

| Area                | Proven now                                                                           | Missing or unproven                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Local runtime       | Runtime audit `GO`; gateway ready; launchd/watchdog cycling                          | Disk is in warning band; no customer-facing HA or safe remote administration                            |
| Revenue             | Adversarial research rejected lead triage and ranked one bounded reconciliation test | 0 buyer interviews, 0 client files, 0 paid audits, 0 verified actions, 0 payments                       |
| Client delivery     | Synthetic `acme_corp/daily-report` compartment, worker, recovery, and evidence       | No production registration path for a new customer worker                                               |
| Knowledge           | Exact tenant scopes, opaque partitions, bounded redacted query results               | No document connector, answer service, citations, or gateway composition                                |
| Models/economics    | Deterministic routing, context budgets, per-client usage ledger                      | Model execution is explicitly disabled; no provider credentials or hard spend limits                    |
| Identity/security   | Loopback-only control plane and deny-first client policies                           | Request header is not employee authentication; no SSO, document ACLs, secrets manager, or DPA           |
| Lifecycle           | Transactional client creation and rollback                                           | No complete suspend, credential rotation, export, retention expiry, verified deletion, or restore drill |
| Customer experience | Local operator dashboard                                                             | No separately authenticated employee interface                                                          |

Authoritative implementation evidence includes
[`src/knowledge/query-service.ts`](../../src/knowledge/query-service.ts),
[`src/knowledge/graphify-runtime.ts`](../../src/knowledge/graphify-runtime.ts),
[`src/economics/model-router.ts`](../../src/economics/model-router.ts),
[`src/clients/service.ts`](../../src/clients/service.ts), and
[`docs/operations/unattended-runtime.md`](../operations/unattended-runtime.md).

## Critical path

### Gate 0 — Founder decisions (before changing the product)

- [x] Pause the lead-triage offer as a commercial wedge; keep its synthetic proof.
- [x] Select Retainer Margin Reset as the only `pursue_now` research hypothesis.
- [ ] Identify ten warm split-stack agencies and confirm which meet the hard preflight gates.
- [ ] Keep the Company Intelligence beachhead parked unless a warm design partner requests it.
- [ ] Decide whether owning/fine-tuning model weights is a requirement or only an optional later
      capability. Recommendation: keep the product provider-neutral and retrieval-first.
- [ ] Choose a legal sender identity, business address, sender mailbox, and bookkeeping owner.

**Done when:** one ICP, buyer, promise, boundary, and commercial owner are written and approved.

### Gate 1 — Acquire before overbuilding

- [ ] Hold ten operator-led warm agency conversations using the demand-pivot conversation guide.
- [ ] Obtain three export schemas and one paid Retainer Margin Reset pilot before building a generic
      reconciliation platform.
- [ ] Deliver the first audit manually and record export effort, match coverage, actionable findings,
      and the buyer's exact decision.
- [ ] Conduct five fragmented-staffing interviews only after the first agency pilot is underway.
- [ ] Keep all sending, file acceptance, pricing, and payment actions separately operator-approved.

**Done when:** two audits are paid, matching exceeds 95%, and at least one buyer takes a pricing,
scope, staffing, or account action—or the stop conditions reject or reshape the offer.

### Gate 2 — Commercial operating minimum

- [ ] Create a one-page offer, synthetic demo narrative, security/data-flow summary, and honest FAQ.
- [ ] Prepare SOW, acceptance schedule, DPA/data-handling terms, subprocessor list, retention and
      deletion terms, support hours, incident contacts, and offboarding procedure with qualified
      professional review where required.
- [ ] Establish manual invoice/payment evidence and bookkeeping; x402 is not required.
- [ ] Extend revenue contracts with distinct `company_knowledge_audit` and
      `company_intelligence_pilot` needs/deliverables only after offer approval.
- [ ] Add an operator CLI or authenticated local workflow for qualification, offer, draft, opt-out,
      and audit transitions.

**Done when:** a buyer can sign, pay, understand the security boundary, and stop/offboard without an
improvised process.

### Gate 3 — Synthetic Company Intelligence proof

Build test-first, using synthetic documents and questions only:

- [ ] Authenticated identity binds a server-selected tenant and one fixed access group.
- [ ] A tenant-document schema records source, version, owner, timestamps, checksum, classification,
      and tombstone state.
- [ ] One approved-bundle ingestion worker parses, chunks, versions, deletes, and atomically publishes
      a client-private index with restart recovery.
- [ ] A separate document retrieval adapter performs bounded scoped retrieval. Do not repurpose the
      structural Graphify adapter as the document engine.
- [ ] A provider-neutral model executor adds managed secrets, timeouts, retries, structured
      answer/citation/abstention output, and provider-policy checks.
- [ ] A client-private Q&A/feedback store avoids the global run input/output ledger.
- [ ] The existing context budget and usage ledger gain per-client query, rate, and spend ceilings.
- [ ] A 30–50-question synthetic gold set tests grounding, citations, abstention, deletion, stale or
      conflicting sources, prompt injection, isolation, recovery, and provider failure.

**Done when:** every hard gate in [`company-intelligence/PILOT.md`](./company-intelligence/PILOT.md)
passes and an independent reviewer finds no unresolved P0/P1 issue.

### Gate 4 — Paid single-tenant pilot

- [ ] Deploy an employee data plane separately from Jarvis, with TLS, authenticated named users,
      rate limits, managed secrets, private logs, backup/restore, and enforced process/network
      isolation.
- [ ] Sign the exact corpus, transfer, retention, deletion, evaluation, support, and stop boundary.
- [ ] Build against synthetic acceptance documents first.
- [ ] Accept one minimized real bundle, then rerun isolation, malformed-input, recovery, deletion,
      and gold-set checks.
- [ ] Shadow with named reviewers before employees rely on answers.
- [ ] Report observed quality, abstention, freshness, latency, failures, adoption, and cost without
      claiming unmeasured ROI.

**Done when:** the buyer signs the agreed evaluation and no security or source-ownership gate is red.

### Gate 5 — Production and repeatability

- [ ] Add SSO and source-ACL propagation before mixed-visibility data.
- [ ] Add incremental connectors only in measured demand order.
- [ ] Prove credential rotation, suspend, export, retention expiry, verified deletion, backup/restore,
      incident response, alert delivery, rollback, and deployment audit.
- [ ] Clear the local disk warning before storage-heavy indexing and package immutable releases.
- [ ] Create a case study using verified customer-approved outcomes.
- [ ] Standardize audit, pilot, rollout, and managed-improvement templates.
- [ ] Test LoRA/fine-tuning only against a measured behavior failure that retrieval and prompting do
      not solve.

**Done when:** a second client can be onboarded from reviewed templates without weakening isolation
or inventing pricing, quality, or ROI claims.

## Outreach strategy

### Message hierarchy

1. **Problem:** “Your team repeatedly searches Slack, docs, tickets, and code for answers that
   already exist.”
2. **Outcome:** “We provide cited answers from approved company knowledge.”
3. **Trust:** “Read-only, permission-bound, and able to say it lacks evidence.”
4. **Wedge:** “Start with one department and one approved source; no platform migration.”
5. **Ask:** a 20-minute knowledge-friction interview, not access to data.

### Channel order

1. Warm founder/operator introductions.
2. MSP, IT consultancy, and operations-consultant partnerships.
3. Manual, evidence-based outreach to a small target list.
4. Content demonstrating the synthetic evaluation and security boundary.

Never send automatically, scrape private contacts, diagnose a company's pain from public evidence,
or upload prospect data into a demo.

## Weekly scorecard

Track separately:

- acquisition: interviews, qualified problems, audits proposed/signed, pilots proposed/signed;
- product: gold-set correctness, citation validity, abstention, retrieval recall, stale answers, and
  observed permission-test failures;
- operations: successful refreshes, provider failures, incidents, backup/restore evidence, and disk;
- economics: measured labor, provider/index usage, cost per accepted answer, support time, proposed
  value, invoiced amount, collected amount, and recognized revenue.

Unknown remains unknown. A prospect is not qualified, a proposal is not revenue, and a passing
synthetic demo is not a secure production deployment.

## Immediate next ten actions

1. Establish the legal sender, mailbox, address, invoice, and bookkeeping path.
2. Write the one-page Retainer Margin Reset scope and paid-on-delivery terms.
3. Create a synthetic evidence pack without prospect or client data.
4. List ten warm agencies and qualify stack, retainer count, time coverage, and repricing trigger.
5. Hold conversations without diagnosing from public data or automating outreach.
6. Inspect three schemas and measure whether the 30-minute export and 95% match gates are realistic.
7. Sign and deliver one manual audit before building a platform.
8. Seek a second paid audit and record the buyer action, not merely the finding.
9. Conduct five staffing pay-to-bill interviews while the agency test runs.
10. Apply the 30-day stop conditions in `demand-led-pivot.md` and continue, reshape, or kill.

## Not on the critical path

- x402 mainnet, public MCP hosting, wallets, or autonomous payment;
- autonomous outreach or prospect qualification;
- multi-tenant SaaS, Kubernetes, or a large connector catalog;
- training a custom model before a measured need;
- exposing the current loopback operator gateway to clients.
