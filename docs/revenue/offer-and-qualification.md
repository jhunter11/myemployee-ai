# Offer and Qualification

## Segment hypothesis

Start with independent or regional residential roofing contractors in the Charlotte metro. The
public pages in this pack show three relevant signals: estimate or inspection intake, residential
repair/replacement work, and a local or bounded regional service footprint. Several also publish a
response window or storm-damage workflow.

Those signals support a discovery conversation; they do **not** prove lead volume, slow response,
lost sales, CRM gaps, budget, or buying intent. Never tell a prospect that Jarvis found a problem in
their business. Ask.

## Concrete offer: Daily Lead Triage Pilot

**Promise:** using the prospect's agreed qualification rules, transform one bounded daily CSV export
into a client-only, reviewable qualified-lead brief with deterministic run evidence.

### Included

- One source export with a fixed, documented schema.
- One agreed qualification ruleset; deterministic rules run before any model call.
- Up to 31 daily runs in the first month.
- A structured report containing source-row count, qualified count, and the agreed qualified fields.
- Per-run success/failure evidence and one operator-facing exception path.
- One revision round to the mapping or rules during the first month.
- A data-retention and offboarding decision before real data is accepted.

### Excluded unless separately scoped

- CRM writes, ad-platform access, inbox access, automated email/SMS/calls, or autonomous follow-up.
- Lead scoring invented by a model, predictions, revenue attribution, or an ROI guarantee.
- More than one source, free-form spreadsheets, unbounded attachments, or historical data cleanup.
- Insurance, contracting, or homeowner decisions.
- Any integration that has not passed a tenant-boundary and failure-recovery review.

The existing proof writes a structured report inside a client compartment. Delivery integrations
are not represented as complete.

## Price and exact micro-USD math

Jarvis stores money as integer micro-USD, where `1 USD = 1,000,000 micro-USD`.

| Item                  |          USD | Integer micro-USD | Terms                                       |
| --------------------- | -----------: | ----------------: | ------------------------------------------- |
| Blueprint floor       |   $500/month |       500,000,000 | Lower bound, not this offer                 |
| Founding first month  |   $750/month |       750,000,000 | No setup fee; one-month minimum             |
| Standard continuation | $1,250/month |     1,250,000,000 | Monthly in advance after signed scope       |
| Blueprint ceiling     | $2,000/month |     2,000,000,000 | Multi-source expansion requires a new scope |

Calculation: `USD × 1,000,000 = micro-USD`. Proposed price is not booked or collected revenue.
Margin and ROI remain unknown until real delivery usage and buyer outcomes exist.

## Public-fit rubric

The research score is only a prioritization tool. Award one point for each current official-site
signal:

1. Residential roof repair, inspection, or replacement.
2. A public estimate, quote, or inspection intake path.
3. A local or bounded regional footprint.
4. A published same-day, next-day, or other clear response window.
5. A storm, insurance, emergency, or repair workflow where triage may matter.

Scores in `first-client-pack.json` are based on public pages as of 2026-07-18. A score of 5 is not a
sales qualification and is not a claim about operational quality.

## Discovery qualification rubric

Ask the same questions in the same order. Score only the prospect's answers.

| Criterion             | 0 points               | 1 point                      | 2 points                                                         |
| --------------------- | ---------------------- | ---------------------------- | ---------------------------------------------------------------- |
| Weekly inbound volume | Fewer than 10          | 10–24                        | 25 or more                                                       |
| Sources and handoffs  | One clean system       | One manual handoff           | Multiple sources or repeated manual merge                        |
| Triage burden         | No recurring burden    | Occasional backlog           | Recurring delay, rework, or 3+ staff hours/week                  |
| Safe export           | No export              | Export needs a bounded setup | Current CSV/API export with stable fields                        |
| Commercial readiness  | No owner/budget/timing | One is unclear               | Decision authority, $750 first month, and start window confirmed |

Mandatory gates, regardless of score:

- A safe bounded export is feasible.
- The person approving the pilot has decision authority.
- Qualification rules can be written without model judgment.
- Data fields, retention, delivery, and deletion are agreed in writing.
- Success can be measured without promising revenue.

Decision:

- **7–10 and all mandatory gates:** proposal-ready.
- **5–6:** discovery follow-up; do not propose yet.
- **0–4 or any hard gate fails:** disqualify or park.

## Ten-minute discovery outline

1. “How do estimate requests enter the business today?”
2. “What happens between a new request and the first sales response?”
3. “Roughly how many arrive in a normal and storm-heavy week?”
4. “Which fields make a request ready for an inspection or callback?”
5. “Can your current system produce a daily CSV with those fields?”
6. “What would a useful daily brief change for the team, if anything?”
7. “Who owns this workflow and could approve a one-month $750 pilot?”

End with a recap and ask permission for the next step. Do not diagnose, quote ROI, or request data on
the discovery call.
