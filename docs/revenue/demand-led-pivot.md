# Demand-Led Product Pivot

**Decision date:** 2026-07-21
**Status:** research decision; buyer validation required
**Outbound authority:** none

## Decision

Pause the Daily Lead Triage Pilot and stop treating a generic AI agent as the product.

The first commercial test is a **Retainer Margin Reset**: a manually delivered, deterministic,
one-time reconciliation for split-stack professional-services firms. The broader product direction
is a reusable file-reconciliation workbench with narrow industry playbooks. Verticalize the offer,
not the core engine.

This is not product-market-fit evidence. As of this decision there are:

- zero buyer interviews about these offers;
- zero client files inspected;
- zero paid audits;
- zero verified recoveries, repricing actions, or retained revenue.

The research ranks hypotheses. A buyer supplying files and paying is the next proof.

## What the prior workflow actually completed

Claude's `pivot-lane-discovery` workflow was marked `completed`, but its substantive work stopped at
the usage limit:

- six blue-team lane proposals completed: professional services, accounting, legal, e-commerce,
  healthcare, and field services;
- SaaS stopped mid-research and distribution never started;
- every red-team attack failed;
- every rebuttal failed;
- both judges and the synthesis failed;
- the stored workflow result contained zero lanes and zero survivors.

The continuation recovered the full blue-team outputs, completed the two missing lanes, ran
red-team reviews with current vendor checks, cross-fed the attacks for rebuttal, and used a separate
skeptical judge. That process killed most of the original list.

## Why the roofing offer failed

The Daily Lead Triage Pilot is a useful technical proof and a bad commercial wedge:

- a $1M-$5M roofer receives roughly 3-7 leads per business day, so the denominator is too small;
- the plausible displaced admin labor is below the proposed monthly price;
- asking for a daily export makes the buyer perform the triage before receiving the triage;
- a CRM saved view, Excel filter, or existing office process is a sufficient substitute;
- a daily batch adds latency to a workflow where speed matters;
- no action is taken after classification, so the output does not create a new result.

Do not repair this offer with a better pitch. Preserve it as a synthetic engineering fixture only.

## What small businesses actually need

Most small businesses do not need a general agent. They need a bounded answer before a decision:

- Which three contracts should I reprice or rescope?
- Which approved or paid hours were never invoiced?
- Which earned rebates were never credited?
- Which specific exceptions can I correct this month?

Small workflows make labor-saving automation difficult to price because the wage ceiling is low.
A viable small-business product instead needs:

1. high monetary event density despite low headcount;
2. a number split across systems the buyer already uses;
3. files obtainable without credentials or premium APIs;
4. an owner-controlled action within 30 days;
5. row-level evidence that makes trust possible without case studies.

Company size is a weak first filter. Operational volume, system fragmentation, and the action lever
matter more.

| Buyer size              | Default decision                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1-9 employees           | Usually no offer. Qualify only businesses with thousands of monetary events or hundreds of subscription accounts.   |
| 10-49 employees         | Best initial range: enough volume and fragmentation, but still owner-led and signable.                              |
| 50-100 employees        | More value, but stronger incumbent software, finance staff, security review, and procurement. Require a warm route. |
| More than 100 employees | Park for now unless a warm design partner requests a bounded audit.                                                 |

## Pursue now: Retainer Margin Reset

### Exact buyer

A professional-services firm with:

- 15-60 delivery staff;
- at least 10 active monthly retainers;
- at least 12 complete months of time data and at least 90% time-entry compliance;
- invoices in QuickBooks Online, Xero, or another system not linked to time-tracker projects;
- an owner able to supply loaded cost by role or a minimum acceptable effective rate.

Disqualify Productive, Scoro, and any Harvest account already using linked recurring invoices,
populated cost rates, and active profitability reporting. Harvest exports are broadly available,
but Harvest also has a native profitability report; the offer exists only when the buyer's current
configuration does not already produce the answer. See
[Harvest exports](https://support.getharvest.com/hc/en-us/articles/31625325401229-Exporting-data),
[Harvest profitability](https://support.getharvest.com/hc/en-us/articles/25342727197581-Profitability-report),
and [invoice-project linking](https://support.getharvest.com/hc/en-us/articles/360048686631-Linking-invoices-to-projects).

### Promise

> I will show you which retainers crossed your minimum margin, when they crossed it, and give you
> the evidence packs for the three scope, fee, or staffing conversations that matter most.

Do not say a client is "working for free." More hours do not prove scope creep, and a low effective
rate does not prove a loss. Compare the firm's own retainer revenue with its own cost or minimum-rate
threshold.

### Preflight

Proceed only when:

- one month of data matches at least 95% of retainer revenue and hours to clients;
- pass-through expenses, subcontractors, hosting, and one-time projects can be separated;
- contract scope or cap is available before labeling work out of scope;
- at least three retainers show both a greater than 25% effective-rate decline and below-target
  margin.

If the threshold is not met, stop. A clean result is not permission to manufacture a finding.

### Deliverable and terms hypothesis

- portfolio table: fee, hours, loaded cost, effective rate, margin, and 12-month slope;
- three evidence-linked client action packs;
- one owner-selected lever per client: raise fee, reset scope, cap hours, change staffing mix, or
  deliberately accept the margin;
- conversation worksheet, with no automated outreach and no promised price increase;
- 3-5 business days;
- $750-$1,000 paid on delivery; cap the fee at $250 if the agreed finding threshold is not met.

These prices are validation hypotheses, not established willingness to pay.

## Validate next

| Rank | Offer                              | Qualification and reason to test                                                                                                                                                                             | Main risk                                                                                                                      |
| ---: | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
|    2 | Paid-vs-billed staffing hours      | Fragmented staffing or event-labor firm using Deputy/When I Work, Gusto/ADP, and QuickBooks separately. High hourly-event density and a direct supplemental-invoice or rate-table lever.                     | Three or four files, payroll sensitivity, rate-card complexity, and strong integrated substitutes such as Bullhorn or Avionte. |
|    3 | Accounting Repricing Evidence Pack | At least 30 recurring clients, Ignition plus Dext, repricing window inside 60 days, and six monthly exports obtainable in 30 minutes. Volume ranks candidates; the owner must supply other workload drivers. | Document count is not workload, Dext history is export-heavy, and accountants are strong spreadsheet substitutes.              |
|    4 | Supplier rebate recovery           | Distributor with at least $3M eligible purchasing, five rebate programs, structured terms, and a claim or measurement deadline inside 60 days.                                                               | Bespoke terms require normalization, and Enable, Vistex, or SAP may already own the workflow.                                  |

For staffing, standard file exports are plausible, but integrated suites erase the seam. See
[Deputy timesheet exports](https://help.deputy.com/hc/en-au/articles/10280964458895-Export-Timesheets-as-format-CSV-Excel-All-Fields),
[Gusto report exports](https://support.gusto.com/article/101334493100000/view-download-and-customize-reports-in-gusto-for-admins),
and the integrated substitutes from
[Bullhorn](https://kb.bullhorn.com/bhone/Content/BH1/Topics/timesheetBillableChargesCustomerRequiredFields.htm)
and [Avionte](https://www.avionte.com/payroll-billing/).

The accounting idea is narrower than the original proposal. Dext documents a selected billing
period export, not a simple 24-month history. See
[Dext subscription usage](https://help.dext.com/en/articles/216169-how-to-manage-your-dext-practice-subscription)
and [Ignition service-revenue export](https://support.ignitionapp.com/en/articles/2643778-exporting-your-services-revenue-from-the-home-tab).

## Parked and killed

### Parked until a buyer arrives with the trigger and files

- SaaS closed-won-to-cash and entitlement-to-cash reconciliation;
- supplier price-increase exposure scans;
- 3PL contract-rate audits and dimensional-weight root-cause work;
- one-receipt landed-cost analysis;
- a veterinary IDEXX/PIMS exception check for a known broken or absent integration;
- loaded agency margin as an upsell after trust is earned;
- Company Intelligence for 25-250-person firms as a separate, slower flagship lane.

Modern billing and entitlement products narrow the SaaS seams. HubSpot synchronizes QuickBooks
customers, products, invoices, and credits, while Stripe and Chargebee provide entitlement
primitives. See [HubSpot's QuickBooks integration](https://knowledge.hubspot.com/integrations/connect-hubspot-and-quickbooks-online),
[Stripe Entitlements](https://docs.stripe.com/billing/entitlements), and
[Chargebee Entitlements](https://www.chargebee.com/docs/billing/2.0/entitlements/subscription-entitlements).

### Killed for the current operator

- roofing lead triage and other low-volume classification products;
- legal trust, case-cost, or payment audits without a credentialed legal-accounting partner;
- dental allowed-amount audits and med-spa inventory attribution;
- generic healthcare automation;
- Jobber visit-to-invoice, Housecall Pro membership, and heuristic callback audits;
- inventory aging, reorder, margin, open-PO, duplicate-bill, and generic dashboard products already
  provided by incumbent software;
- merchant-processing fee audits with free substitutes;
- generic AI agents, inbox classifiers, report generators, and recurring manual-export workflows.

The field-service ideas failed because current products already expose the relevant states or
because the proposed join misread the billing model. See
[Jobber's Visits Report](https://help.getjobber.com/hc/en-us/articles/22081958176407-Visits-Report),
[Jobber recurring invoicing](https://help.getjobber.com/hc/en-us/articles/115009542848-Create-a-Recurring-Job),
and [Housecall Pro's service-plan dashboard](https://help.housecallpro.com/en/articles/2932107-service-plans-dashboard-overview).

## Factorable product design

Do not build a vertical SaaS product before the manual service is purchased. When evidence justifies
building, keep one shared deterministic workbench:

1. **Preflight:** inspect headers, minimize sensitive fields, measure usable coverage, identify
   native substitutes, and estimate the maximum credible value before accepting the engagement.
2. **Ingest:** bounded CSV/XLSX schemas, checksums, tenant-scoped storage, and explicit retention.
3. **Normalize:** aliases, dates, units, identifiers, and effective periods with ambiguous rows held
   for review.
4. **Reconcile:** exact and deterministic joins, rules, thresholds, and visible unmatched rows.
5. **Quantify:** separate recoverable, repriceable, preventable, and merely theoretical dollars.
6. **Evidence:** drill-down exception table, source references, assumptions, and an action queue.
7. **Vertical playbook:** named system pair, qualification gates, mapping rules, action lever, and
   buyer-facing evidence pack.

This makes a new lane an adapter and playbook, not a new agent architecture.

### Where agents may help later

Businesses may eventually value an exception-monitoring agent after the audit proves the exception
recurs and data arrives automatically. The agent should prepare evidence and an action queue; it
should not invent money, choose the tenant, change prices, contact customers, or move funds.

Jarvis may eventually use internal agents to propose schema mappings, identify ambiguous rows, or
draft explanations. Deterministic code and a human reviewer must still control matching, arithmetic,
authority, and external action. Model execution remains out of V1.

## Hard-gate scorecard

Reject an offer when any answer is no:

1. Is there one named ICP and a trigger inside 60 days?
2. Is the actual transaction or contract denominator large enough?
3. Can every input be exported once, without credentials, in 30 minutes?
4. Does the answer genuinely live between systems rather than in a built-in report?
5. Is the credible recoverable, repriceable, or preventable value at least five times the price?
6. Can the owner invoice, claim, reprice, rescope, or terminate within 30 days?
7. Can deterministic matching exceed 95% with traceable evidence?
8. Does the ten-minute demo show one dollar exception and its receipts rather than an Excel filter?
9. Can the first sale happen without APIs, recurring exports, case studies, or a long security review?
10. Has a real buyer supplied files and paid?

Question ten keeps every untested lane in `research_only`, regardless of the other score.

## Thirty-day evidence plan

### Days 1-3

Create only the Retainer Margin Reset offer sheet, synthetic evidence pack, qualification form, and
preflight matcher. Do not build a platform.

### Days 4-10

Hold ten operator-led warm agency conversations. Target five qualified firms, three willing to show
export schemas, and one paid pilot. No automated outreach or unapproved sending is authorized.

### Days 11-18

Deliver the first audit manually. Record export time, match rate, qualifying-retainer count, owner
reaction, and the exact action selected.

### Days 19-24

Seek a second paid audit. In parallel, conduct five fragmented-staffing interviews without building.

### Days 25-30 decision

Continue Retainer Margin Reset only when:

- at least two audits were paid;
- matching reached at least 95%;
- at least one buyer took a pricing, scope, staffing, or account decision.

Stop or reshape when:

- fewer than three of ten agencies qualify;
- no paid pilot closes after five qualified conversations;
- exports take more than 30 minutes;
- findings only confirm what owners already knew;
- the credible actionable value is below five times the fee.

Promote staffing to a paid test only if two firms confirm either a recent $5,000-plus discrepancy or
a material weekly reconciliation burden and one provides sample schemas. Do not start accounting or
rebate implementation without a deadline-qualified buyer willing to pay.

## Conversation guide

Use conversation to recover facts, not compliments:

1. “Walk me through the last time you decided to reprice or rescope a client.”
2. “Which number did you wish you had, and how did you reconstruct it?”
3. “What systems held the two halves?”
4. “Can you show me the report menus, without opening client data?”
5. “What does your current software already report?”
6. “How many clients or transactions were in the last twelve months?”
7. “If I showed one exception with its source rows, what could you change this month?”
8. “What have you paid or tried before?”
9. “Would you review a fixed paid-on-delivery scope for this exact result?”

Interest is not demand. A reviewed scope, supplied schema, paid invoice, and action taken are demand
evidence in increasing order of strength.
