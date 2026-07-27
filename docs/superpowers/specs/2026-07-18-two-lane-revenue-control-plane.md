# Jarvis Two-Lane Revenue Control Plane

**Date:** 2026-07-18  
**Status:** Approved direction; payment activation gated  
**Primary objective:** make Jarvis operational enough that the remaining commercial step is acquiring the first buyer or agency client.

## Decision

Jarvis operates two explicit revenue lanes over one safety/control plane:

1. **AI Agency** — prospects, onboarding, compartment readiness, delivery runs, approvals, follow-ups, and client economics.
2. **Agent Task Market** — bounded machine-readable jobs advertised through an A2A-compatible contract and paid through x402.

Platform reliability, knowledge maintenance, and ToolSmith proposals are internal work domains. They may block a revenue lane but are not presented as a third business.

The lanes share deterministic queue policy, audit/event infrastructure, model economics, and operator UX. They do not share tenant data, wallets, prospect PII, or execution roots.

## Evidence from existing repositories

- `jhunter11/pmqs@6fbd6d4fe0b9b17c18d5560fb1507a6cd66ac6d4` is the safest first compartment proof: MIT, deterministic offline fixture, no live order placement, and a real test suite.
- `jhunter11/ai-company@6bc2976` supplies the domain-lane, anti-starvation, and core-versus-tenant design semantics.
- `jhunter11/fleet` supplies useful queue/audit/event-stream concepts but currently contains design documents, not a reusable implementation.
- No x402 implementation or reusable custom MCP server currently exists in the user's GitHub or inspected local workspaces. Jarvis must not pretend otherwise.

## Lane boundaries

```text
Jarvis harness/control plane
├── Agency lane
│   ├── global agency prospect database
│   ├── client registry and readiness projections
│   └── client compartments (one filesystem, DB, memory, graph, and policy universe each)
├── Task Market lane
│   ├── public task/product catalog (no tenant secrets)
│   ├── A2A task lifecycle projection
│   ├── x402 payment/settlement evidence (no private keys)
│   └── isolated project execution compartments
└── Platform domains
    ├── priority/event log
    ├── economics and health
    └── harness-only knowledge index
```

Agency prospect data is never written to a client's CRM database. Task-market buyer/payment data is never written into an agency client's compartment.

## Query and memory hierarchy

Every query has a principal and an exact scope:

- `harness` — control-plane code and bounded cross-lane metadata.
- `project:<project_id>` — one source project and its execution evidence.
- `client:<client_id>` — one client's sandboxed code, notes, and run evidence.

Graphify generates a different graph file for every scope. A scope binding contains a canonical root and opaque graph path. A client principal may query exactly its own client scope; it may not choose another scope, pass an arbitrary filesystem path, use Graphify's `project_path`, or access a merged/global graph.

Markdown remains the durable agency/client memory source of truth. Graphify is a derived structural code traversal index. Neither replaces the other.

## First project-compartment proof

PMQS is pinned, copied into an ephemeral execution root, and invoked through one fixed fixture command. The proof is successful when:

- the expected PMQS application verdict (including its intentional `FAIL`) is normalized as data rather than confused with a process failure;
- repeated runs are deterministic;
- the source commit remains unchanged;
- no credential, network, sibling tenant, arbitrary argv, symlink, oversized output, or post-timeout process escapes;
- only bounded verdict metadata and a digest cross back into Jarvis.

This validates Jarvis's compartment mechanics. It does not claim PMQS itself is the paid product.

## First Task Market product shape

The first sellable task is deterministic validation over bounded caller-supplied **data**, using a fixed reviewed implementation. It never executes buyer-provided code, shell, packages, URLs, or model prompts.

Candidate contract:

```json
{
  "product": "edge-validation-v1",
  "input": {
    "series": "bounded numeric observations",
    "parameters": "strict allowlisted validation parameters"
  },
  "output": {
    "verdict": "PASS | FAIL | INSUFFICIENT_EVIDENCE",
    "checks": "bounded named check results",
    "provenance": "implementation/version/input digest",
    "usage": "measured compute metadata"
  }
}
```

The open-source algorithm may remain inspectable; buyers pay for reliable hosted execution, provenance, standard output, discovery, and agent-native access.

## A2A + x402 composition

- **A2A-compatible contract:** publishes discovery metadata, skills, input/output types, and task lifecycle. A2A is transport/interoperability, not assumed to provide payment or marketplace demand.
- **x402 seller gate:** advertises a fixed `exact` test price first. A successful payment authorization is required before execution. Usage-based `upto` or batch settlement is deferred until actual metering and reconciliation are proven.
- **MCP tool:** exposes the same underlying strict task contract through a paid wrapper. MCP is an adapter; it never receives broader filesystem or wallet capability.
- **Discovery:** Bazaar metadata may advertise the endpoint only after the testnet contract, rate limits, abuse controls, and evidence are green.

Official references:

- https://docs.x402.org/getting-started/quickstart-for-sellers
- https://docs.x402.org/guides/mcp-server-with-x402
- https://a2a-protocol.org/latest/

## Payment safety gate

Payment activation progresses through explicit states:

1. `contract_only` — schemas and deterministic local tests.
2. `simulation` — fake facilitator/settlement evidence; no wallet.
3. `testnet` — dedicated low-value test wallet, hard caps, no withdrawal automation.
4. `mainnet_blocked` — default production state.
5. `mainnet_enabled` — requires operator-provided receive address, reviewed facilitator, legal/tax decision, secret storage, rate limiting, reconciliation, incident stop, and a typed confirmation record.

Jarvis never stores a seller or buyer private key in SQLite, Markdown, source control, dashboard state, logs, launchd plists, or model context. Seller receive addresses are not secrets, but activation remains operator-reviewed. Mainnet is not enabled merely to satisfy a test or demo.

## Queue ownership

One Jarvis work queue projects work from both lanes. Source systems remain authoritative for their own resources.

- P0: tenant boundary, secret, integrity, wallet, or kill-switch incidents.
- P1: paid delivery failure, settlement/reconciliation mismatch, recovery, or breached SLA.
- P2: client readiness, due agency follow-up, ready paid task, or routine approval.
- P3: improvements, knowledge hygiene, experiments, and ToolSmith proposals.

Each lane selects its highest-priority eligible head; the global arbiter uses deterministic same-band fairness. Model output may summarize evidence but cannot assign or demote safety bands.

## Economics

Record measured cost and outcome by lane, project, client, and operation. Unknown cost stays unknown. Revenue is recognized only from verified settlement or an explicit agency invoice/payment writer. Dashboard metrics must not infer profit, ROI, conversion, or work-per-dollar from template assumptions.

## Activation acceptance

The Task Market lane is ready for buyer discovery only after:

- fixed-contract tests, fuzz/size/timeout tests, and deterministic replay pass;
- task lifecycle and payment states are idempotent and restart-safe;
- settlement evidence reconciles exactly once;
- no private key enters the process or logs;
- testnet end-to-end payment succeeds with tiny value and a hard spend cap;
- the operator dashboard exposes price, payment state, task state, evidence, and kill status without raw payloads;
- the endpoint is authenticated/rate-limited and hosted separately from the loopback Jarvis dashboard.

Until then, the dashboard labels the lane `Build / testnet`, never `Live` or `Revenue`.
