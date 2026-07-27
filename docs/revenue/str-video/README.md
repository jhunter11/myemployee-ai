# STR Walkthrough-Video Product Line

> **Status: `spec_only` — no scraping, no send, no charge yet.** These documents specify two
> products. They do not authorize outreach, payment collection, publishing, or a revenue claim.
> Every outward-facing action inherits Jarvis's existing **operator-approval gate** (see the
> `blocked_pending_operator_review` pattern in [../README.md](../README.md) and the supervisor's
> no-send boundary). Building the pipeline is allowed; _operating_ it against real people is a
> separate, human-approved step.

## What this is

A short-form / walkthrough video service for short-term-rental (STR) operators, generated largely
with AI from property photos, and the two ways to monetize it:

- **Version A — Operate** ([SPEC-operate.md](./SPEC-operate.md) · [TASKS-operate.md](./TASKS-operate.md)):
  Jarvis runs the pipeline as a done-for-you service — source reachable STR operators, produce a
  sample, get an operator-approved sale, deliver consented, QC'd video.
- **Version B — Resell** ([SPEC-resell.md](./SPEC-resell.md) · [TASKS-resell.md](./TASKS-resell.md)):
  Package the _same_ pipeline as a productized kit + community sold to young "AI side-hustle"
  creators. Version B depends on Version A having real proof first (see sequencing below).

## The one thing that changed the design

The original pitch was "make a walkthrough video the host posts **to their Airbnb listing** to boost
conversion." That specific mechanic is dead: as of the 2026 Summer Release Airbnb does **not** allow
host-uploaded video on home listings, and its Off-Platform Policy (Help art. 2799) bans external
links in listings. Verified against Airbnb's own help center, three times across independent checks.

The value that **does** exist is off-Airbnb marketing — and that is what these specs sell:

| Channel                             | Video supported?                                   | Use                                               |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Instagram / Facebook host groups    | Yes                                                | Drive direct traffic; the observed real-world use |
| Direct-booking website              | Yes (host owns it)                                 | Hero video / embedded tour                        |
| Vrbo                                | Yes — **native** listing video (mp4, <2 min, 9:16) | On-listing tour on a real channel                 |
| Booking.com                         | Yes (upload or YouTube embed)                      | On-listing tour                                   |
| Airbnb listing gallery              | **No**                                             | — (do not sell this)                              |
| Airbnb description / guidebook link | Link only, gray-area                               | Guest-trust link, with a scam-safety caveat       |

**Positioning rule (non-negotiable):** we sell _marketing content for the operator's owned channels_.
We never promise an "Airbnb conversion lift" or a booking-count guarantee — the causal evidence is
for professional **photos**, not video, and any on-Airbnb use is unattributable. Overclaiming is both
a churn driver and an FTC exposure.

## Demand basis — what is verified vs. what the first sales must prove

**Verified (real):**

- STR operators actively want marketing content: 57% name "driving direct bookings" their top
  challenge; direct bookings are a top operator goal; hosts already buy/share these videos in
  Facebook host groups (operator-supplied evidence + research).
- Reachable buyers exist: property managers and direct-booking operators publish websites, contact
  forms, and Instagram handles — unlike individual Airbnb hosts, whose contact info Airbnb hides
  (~0% automatable reach — do not target them cold).
- A done-for-you AI-video service tier ($100–$750/video) exists between the $29/mo self-serve tools
  and $300–$5,000 human shoots — real margin room for a _service_, not raw tool resale.

**Must be proven by the first 3–5 sales (kill criteria below):**

- Willingness to pay _our_ price for AI-from-photos video vs. a real shoot or a $29 tool.
- That the AI output clears a quality bar buyers will publicly post under their own brand.
- That compliant outreach converts at a rate that supports the unit economics.

## Guardrails baked into both specs

1. **Compliant sourcing only.** Target operators with a _public_ contact channel. No scraping of
   Airbnb's hidden host contacts (breaches ToS §11.1; ~0% yield for individuals anyway).
2. **Consented, owned assets for paid work.** The paid deliverable is built from assets the buyer
   uploads and confirms they own. A pre-sale _sample_ from public photos is used **only** 1:1 in
   outreach as a demo, never published, and is replaced by consented assets on purchase.
3. **Make-after-payment.** No speculative batch production (cold close rates are 1–3%; pre-building
   burns money and creates orphaned derivatives of others' images).
4. **Mandatory human QC gate.** Every asset is reviewed for hallucination artifacts (warped
   walls/mirrors/floors) before delivery. AI-motion disclosure label on delivered video.
5. **Operator-approved send.** Every outreach message and every payment request passes the existing
   human-approval gate. Jarvis drafts; a human approves the specific recipient/channel/body.
6. **Honest automation claim.** ~65–70% of _steps_ are agentic; closing, QC, and dispute handling
   are human and are where the money and liability sit. We do not market "95% automated."
7. **Right tool.** Walkthrough/animation via purpose-built real-estate photo-to-video with an API/MCP
   (Pedra API + MCP, Luma API, or VideoTour.ai). ViewMAX is a generic viral-video tool — usable for
   social punch-up, not as the "walkthrough" engine.

## Kill criteria (stop and reassess if any is true after the pilot cohort)

- Fewer than **2 paid deliveries** from the first **~150 compliant, operator-approved outreaches**.
- Buyers consistently rate the AI output "too fake to post under my brand."
- Any chargeback/"not as described" rate above **10%** of orders.
- Any platform ToS strike, copyright complaint, or compliance notice.

## Sequencing (A before B)

Version B sells a promise; that promise is only honest and FTC-defensible once Version A has produced
**real, documented case studies and earnings**. Build A → run a small operator-approved pilot →
capture proof → then package B. B's task list is explicitly gated on A's proof pack.

## Evidence labels (inherited from the revenue-docs convention)

- `spec_only` — specified, nothing built or sent.
- `built_unverified` — code/assets exist; no real prospect or buyer touched.
- `pilot` — operator-approved sample/outreach against real, verified-public businesses.
- `won` / revenue — a real signed order and verified payment. Neither product has this yet.

## Files

- [SPEC-operate.md](./SPEC-operate.md) — Version A technical + operational spec.
- [TASKS-operate.md](./TASKS-operate.md) — Version A sequenced, scoped task list.
- [SPEC-resell.md](./SPEC-resell.md) — Version B product + compliance spec.
- [TASKS-resell.md](./TASKS-resell.md) — Version B sequenced, scoped task list.
