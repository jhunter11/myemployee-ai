# Version A — STR Video Pipeline (Operate) — Task List

> Implements [SPEC-operate.md](./SPEC-operate.md). Tasks are compartmentalized so an agent can pick
> one up in isolation and complete it. **Sequence is the dependency order.** Each task follows the
> repo convention: `Type / Depends on / Complexity / Done when`. Write failing tests first where the
> repo's TDD pattern applies. **No task authorizes a real send, charge, or contact-scraping** — those
> stay behind the operator gate until Task A12's explicit go decision.

**Total tasks:** 12 · **Critical path:** A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9 → A10 → A11 → A12
**Parallelizable:** A2 (schema) and A4 (VideoProvider) can start once A1 lands; A11 (usage guide)
can be drafted anytime after A1.

---

### Task A1: Product scaffold, contracts, and compartment

**Type:** infrastructure, code · **Depends on:** none · **Complexity:** moderate

Create the `str-video` client-style compartment: isolated SQLite from the client template, Zod
contracts for `lead`, `sample`, `outreach_review`, `order`, `consent`, `qc_record`, `ledger_entry`,
and a registered worker namespace under the supervisor. No business logic yet.

**Done when:** compartment initializes from template, contracts typecheck, a no-op worker run emits
the standard `agent_runs` + Mermaid trace, and focused schema tests pass.

---

### Task A2: Lead + order data model and repositories

**Type:** code · **Depends on:** A1 · **Complexity:** moderate

Implement repositories for leads, orders, consent records, QC records, and the unit-economics ledger,
with additive migrations. Enforce the data-minimization rule at the type level: lead records carry
**public** business label, public channel, source URL, and signals only — no personal names or
scraped private contacts.

**Done when:** repository CRUD tests pass through real temporary SQLite; a lint/type rule or schema
constraint rejects disallowed personal fields.

---

### Task A3: Compliant sourcing worker (`source`)

**Type:** code · **Depends on:** A2 · **Complexity:** complex

Build the sourcing worker over **public** sources (Vrbo public listings, direct-booking-site search,
public IG/PM directories, AirDNA/AirROI market data). Emit `lead` records with `reachable` and
`owned_channel` booleans. Hard-exclude any Airbnb-hidden-contact source. Rate-limit and cache.

**Done when:** running against a fixture/replayed source set yields scored leads with a public
channel each; a test asserts zero private-contact fields are ever populated; excluded sources are
rejected by policy.

---

### Task A4: `VideoProvider` abstraction + one real integration

**Type:** code · **Depends on:** A1 · **Complexity:** complex

Define a `VideoProvider` interface (`makeSample(photos, opts)`, `makeDeliverable(assets, opts)`)
and implement it against **one** real API (Pedra primary). Include disclosure-label rendering and
aspect/length presets for social (9:16 ≤15s) and Vrbo walkthrough (mp4, <2min, ≥1080×1920). Use a
**self-owned** test property only.

**Done when:** an integration test (network-gated/mocked in CI, live-run documented) produces a
labeled clip in each preset from self-owned photos; credit cost is recorded to the ledger.

---

### Task A5: Qualification & scoring (`qualify`)

**Type:** code · **Depends on:** A3 · **Complexity:** moderate

Score/rank leads (upscale signal, owned channel that accepts video, reachable public contact,
jurisdiction). Drop non-reachable or non-owned-channel leads. Flag UK/EU individual operators as
`consent_required` (not cold-eligible).

**Done when:** scoring tests cover include/exclude/flag cases; output is a ranked, cold-eligible
shortlist plus a separate consent-required list.

---

### Task A6: Sample generation + sample QC gate (`sample`)

**Type:** code · **Depends on:** A4, A5 · **Complexity:** moderate

Wire qualified leads → `VideoProvider.makeSample` from **public** photos, apply the disclosure label
and the "free sample, unpublished, you own nothing until purchase" marker, and route each sample
through an automated + human QC checkpoint. Failed samples regenerate once, then skip the lead.

**Done when:** a qualified lead produces a QC-passed sample artifact recorded in the compartment; a
failing-artifact fixture is caught and blocked from proceeding.

---

### Task A7: Outreach drafting behind the operator gate (`outreach`)

**Type:** code · **Depends on:** A6 · **Complexity:** complex

Generate a personalized, CAN-SPAM-compliant draft (true public fact, sample link, offer, price,
opt-out, physical address, sender identity) into an `outreach_review` record. **Reuse the existing
`blocked_pending_operator_review` gate** — no auto-send. Refuse to queue cold drafts for
`consent_required` leads.

**Done when:** drafts land in the review queue with all compliance fields; a test proves no code path
sends automatically and consent-required leads are refused; a human-approval action is required to
mark a draft sendable.

---

### Task A8: Payment link + consented intake (`intake`)

**Type:** code · **Depends on:** A2 · **Complexity:** complex

Implement human-approved Stripe payment-link creation and an intake form capturing operator-**owned**
assets, brand prefs, target channels, and the explicit AI-disclosure + ownership + usage consent.
Persist the consent artifact. Enforce **make-after-payment**: no production record can be created
without a cleared payment + stored consent.

**Done when:** a simulated paid+consented order unlocks production; an order missing payment or
consent is blocked; consent artifact is retrievable for audit.

---

### Task A9: Paid production (`produce`)

**Type:** code · **Depends on:** A4, A8 · **Complexity:** moderate

From a paid+consented order, generate the deliverable set (1–3 social cuts + 1 Vrbo-sized
walkthrough) via `VideoProvider`, disclosure label baked in, deterministic motion preferred for the
walkthrough. Record credit cost to the ledger.

**Done when:** a paid+consented test order yields the full labeled deliverable set with per-order cost
recorded; production refuses to run without A8's unlock.

---

### Task A10: Delivery QC gate + dispute-safe delivery (`qc` + `deliver`)

**Type:** code · **Depends on:** A9 · **Complexity:** moderate

Implement the mandatory human QC sign-off (hallucination/brand/format/label checklist) with a
recorded pass/fail; only a recorded pass permits delivery. Package files + a delivery record and
attach the scope/revision terms for dispute defense.

**Done when:** delivery is impossible without a recorded QC pass; a failed QC loops to production; a
delivered order stores files, QC record, and scope terms.

---

### Task A11: Channel usage guide + post-sale flows (`postsale`)

**Type:** code, content · **Depends on:** A10 · **Complexity:** simple

Produce the buyer-facing usage guide (IG/FB groups, direct site, Vrbo/Booking native, gray-area
guidebook link with scam-safety caveat — never a ToS-violating instruction). Implement one included
revision round, the retainer upsell offer, and referral + case-study-consent capture (feeds Version
B).

**Done when:** a delivered order includes the usage guide; revision, retainer, referral, and
case-study-consent records are creatable and tested.

---

### Task A12: End-to-end dry run + pilot go-package

**Type:** integration, ops · **Depends on:** A1–A11 · **Complexity:** complex

Run the full pipeline on **synthetic/self-owned** data start-to-finish, emitting the standard Jarvis
trace with **zero** real sends/charges. Produce the operator runbook, the unit-economics readout, and
a one-page **pilot go-decision** doc listing exactly which real, verified-public businesses would be
approached and the kill criteria. Operating against real people remains a separate human approval.

**Done when:** the dry run passes green with no outward action; runbook + economics readout + pilot
go-package exist and are labeled `built_unverified` pending the operator's explicit pilot approval.
