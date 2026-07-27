# Company Intelligence Assistant Plan

## Problem Statement

Knowledge-heavy teams lose time and confidence when current answers are scattered across documents,
chat, tickets, code, and internal databases. Generic chatbots cannot reliably respect company
permissions, cite the current source, or admit when evidence is missing. Jarvis needs a credible
offer for teams that want faster employee answers without exposing private data or replacing every
system they already use.

## Proposed Solution

Offer a private, permission-aware Company Intelligence Assistant. The first software pilot serves
one client, one department, one uniform access group, and one approved read-only source bundle. It
returns cited answers or an explicit insufficient-evidence response. It performs no workflow action
and does not train on changing company facts. A paid knowledge audit precedes implementation and
defines sources, permissions, risks, a gold evaluation set, support boundaries, and pilot economics.

## Assumptions and Bets

We assume repeated internal questions create measurable friction, a buyer can name an accountable
source owner, and a narrow corpus can prove value before multi-source integration. We are betting
that trust, citations, and permission fidelity matter more than calling the product a custom model.

Identity attachment risk: “a model trained on all company data” is compelling language but may bind
us to the wrong architecture. Retrieval should hold changing facts; fine-tuning or LoRA remains an
optional behavior-specialization layer after measured evidence.

## Thinking Level Declaration

This is a synthesis, not a provider commitment. Cerebras, another managed model, or a local model
could serve inference if it passes the same privacy, quality, latency, and cost gates. The existing
Daily Lead Triage Pilot remains a valid faster path to first revenue.

## Skill Dependencies

- Enterprise discovery, data classification, SOW/DPA scoping, and security communication.
- Authenticated identity, source ACL propagation, secrets, ingestion, retrieval, evaluation, and
  production operations.
- Grounded-answer evaluation, model routing, usage accounting, and incident response.

## Alternatives Considered

| Alternative                             | Why rejected for V1                                                |
| --------------------------------------- | ------------------------------------------------------------------ |
| Fine-tune one model on all company data | Facts change; deletion, citations, and permissions become harder.  |
| Build a multi-tenant SaaS first         | Adds avoidable identity, isolation, support, and procurement risk. |
| Replace the lead-triage offer           | Discards the only currently deliverable paid pilot.                |

## Quadrant Coverage

| Quadrant         | Plan element                                      |
| ---------------- | ------------------------------------------------- |
| Individual Outer | Audit, synthetic demo, pilot, evaluation report   |
| Individual Inner | Claim discipline and security judgment            |
| Collective Outer | Client systems, identity, deployment, support     |
| Collective Inner | Buyer, source owner, security, and employee trust |

## Time Horizons

- **V1:** paid audit and single-source, read-only, cited pilot.
- **V2:** multiple connectors, mixed ACLs, SSO, hybrid retrieval, managed improvement.
- **Not planned:** unrestricted “all data,” autonomous actions, or custom training without evidence.
