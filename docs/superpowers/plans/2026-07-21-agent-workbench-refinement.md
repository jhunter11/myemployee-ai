# Agent Workbench Refinement Summary

## Refinement Summary

**Stress tests passed:**

- **Fake-agent inversion:** Every profile declares `deterministic`, `profile_only`, or `disabled`; the UI never silently substitutes Jarvis or claims execution.
- **Tree-bloat attack:** Profiles are durable navigation and authority records, while reviewers and workers execute only as bounded artifact-specific runs.
- **Authority inversion:** Containment and coordination grant nothing. Tool, sleeve, wallet, and client access remain explicit non-transitive grants.
- **MCP/x402 separation:** Task-market data, runtime, and settlement evidence form a Jarvis sibling domain to Agency and remain simulation-only.

**Edge cases documented:**

- Missing model/provider: profile questions and local deterministic summaries work; generative execution returns `runtime_not_configured`.
- Restart during conversation/run: durable messages plus a versioned continuation checkpoint restore only allowlisted state and evidence references.
- Stale red/blue review: artifact digest/version mismatch rejects the result.
- Missing or stale evidence: synthesis names partial coverage and never interprets missing telemetry as zero.
- Guessed profile/conversation/scope IDs: fail closed without revealing existence outside the bound operator scope.
- Payment dependency failure: x402 work pauses; no retry may broaden price, network, facilitator, or wallet authority.

**Dependency risks:**

- Model conversation adapter: **risky** — isolate behind a provider-neutral port; ship honest profile mode first.
- Remote authentication/ABAC: **high** — retain loopback-only mutations and defer remote access.
- Wallet custody/signing: **high** — exclude from the harness; simulation only.
- Agent-scoped retrieval: **moderate** — authorize before retrieval and use server-resolved partitions.
- Existing static dashboard: **stable** — replace incrementally behind tested read models.

**Plan amendments:**

- Added Agency operations, engineering, ideas, growth, delivery, and governance profiles.
- Added a separate MCP/x402 branch with Publisher, Scout, Seller, and Settlement roles.
- Required a manifest for purpose, tools, sleeves, budgets, handoffs, checkpoints, resume state, and completion.
- Made explicit handoff artifacts the only source for cross-domain Jarvis synthesis.

**Unresolved issues:**

- Model provider and pricing are deferred; V1 does not need them for truthful profile and deterministic chat.
- Testnet/mainnet activation, external sends, and remote mutation require later approvals and security gates.

**Ready for SPEC phase:** yes
