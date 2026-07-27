# Self-Funding Task Market Specification

**Status:** implementation target
**Date:** 2026-07-20
**Control plane:** existing loopback Jarvis gateway
**Public data plane:** separate task-market service

## Outcomes

Jarvis must be able to:

1. execute one bounded deterministic product from HTTP and MCP;
2. require an x402 `exact` payment before paid execution;
3. publish truthful Bazaar-compatible discovery metadata;
4. discover funded Taskmarket work without a wallet or write action;
5. admit scouting only during verified idle capacity;
6. prepare and track task work without treating submission as earnings;
7. reconcile an accepted onchain payout or settled seller payment exactly once;
8. stop all external work through one local kill switch.

## Product contract

`edge-validation-v1` accepts only a bounded numeric series and validation parameters. It executes no
buyer code, URL, package, shell, model prompt, file, or tool. The result is one of `PASS`, `FAIL`, or
`INSUFFICIENT_EVIDENCE` and contains bounded checks, summary statistics, an algorithm version, and a
canonical input digest. It never returns the input series.

The same pure kernel backs:

- `POST /v1/edge-validation`;
- MCP tool `edge_validation_v1` over Streamable HTTP;
- local simulation and replay tests.

## Payment and deployment states

| State             | Network                     | Authority                                         | Revenue claim             |
| ----------------- | --------------------------- | ------------------------------------------------- | ------------------------- |
| `simulation`      | none                        | fake injected gate                                | none                      |
| `testnet`         | Base Sepolia `eip155:84532` | public receive address, official test facilitator | none                      |
| `mainnet_blocked` | Base `eip155:8453`          | configuration rejected                            | none                      |
| `mainnet_enabled` | Base                        | typed reviewed enablement record and kill switch  | verified settlements only |

No private key is required by the seller service. It receives to a public address and delegates
verification and settlement to a reviewed facilitator. Mainnet configuration must fail closed when
the enablement record, address, price, network, facilitator, limits, or approval digest differs.

## Taskmarket worker boundary

Taskmarket descriptions, files, commands, and API content are untrusted. The scout performs public
GET requests only, parses an allowlist, rejects expired or malformed work, and records bounded
metadata plus a description digest. It must not claim, pitch, bid, pay, upload, message, or submit.

An execution candidate records:

- task ID, mode, reward base units, expiry, tags, requester, and description digest;
- estimated cost status (`known` or `unknown`), maximum approved spend, and minimum margin;
- required capabilities, prohibited actions, admission reason, and review state;
- artifact and verification digests without raw confidential content.

Every external write re-fetches the exact task and verifies its current `pendingActions`. Paid,
irreversible, selection, rejection, acceptance, rating, confidential upload, withdrawal, and key
publication require task-specific approval. A broad model instruction is never wallet authority.

## Idle admission

Read-only scouting may run only when all are true:

- the task-market kill switch is enabled;
- core readiness is green and free disk is at least 20%;
- no P0/P1 work is ready or leased;
- no client automation or task-market execution is active;
- the system has been idle for the configured quiet period;
- the scout request and response ceilings are available.

Failure or unknown evidence denies admission. Work execution additionally requires an allowlisted
adapter, a cost ceiling, a verifier, and approval state.

## Persistence and accounting

Logical requests and marketplace actions use stable idempotency keys. Conflicting reuse is denied.
Payment, execution, submission, acceptance, payout, provider cost, and withdrawal are separate
events. Earnings are recognized only from verified settlement/payout evidence; unknown cost remains
unknown. “Pays for itself” requires cumulative recognized revenue to exceed cumulative observed
cost, with both reported for the same scope and period.

## Security invariants

- The public service never imports the Jarvis database, client roots, memory, dashboard, or wallet.
- Request-selected tenants, paths, commands, URLs, providers, and credentials are impossible.
- Bodies, series length, output, concurrency, rate, timeout, and retries are bounded.
- Raw payloads, payment headers, private keys, API tokens, artifacts, and task descriptions never
  enter global logs, dashboards, or model telemetry.
- Public hosting has TLS, rate limits, secure headers, health/readiness, bounded logs, and an
  independently reversible deployment.

## Isolated VPS topology

The control plane, public seller, and task executor are three separate security zones:

- Jarvis remains private with no public ingress. It may publish signed, short-lived job capabilities
  and retrieve quarantined results, but it never accepts a callback from either VPS.
- The seller VPS accepts only public x402 HTTP/MCP traffic. It has no client data, task-execution
  capability, Jarvis route, GitHub credential, or signing key.
- The executor VPS accepts no public ingress. It polls a narrow broker, runs one allowlisted job in
  an unprivileged disposable sandbox, then writes bounded results to quarantine.
- Marketplace CLI/runtime dependencies are confined to disposable executor images and are never
  installed in the Jarvis control plane or seller image. A worker identity, when approved, is
  separate from the revenue wallet and holds no general-purpose funds.
- Result retrieval is not trust transfer: Jarvis verifies schemas, digests, provenance, limits, and
  malware/content policy before importing anything.
- Payment signing remains outside both VPSs and enforces product, network, recipient, amount, rate,
  and expiry independently of model output.

Compromise of either VPS must not grant network reachability or reusable authority into Jarvis.
Containers run without host sockets or privileged mode, with a read-only root filesystem,
capability removal, resource limits, bounded writable storage, and short-lived credentials. The two
VPS roles use separate accounts/projects where the provider permits it.

## Acceptance evidence

- malformed, oversized, replayed, concurrent, timeout, and cross-boundary tests pass;
- unpaid and rejected requests never execute;
- paid simulation executes once and returns deterministic evidence;
- MCP and HTTP invoke the same kernel and expose matching schemas;
- scout fixtures prove prompt injection cannot create authority;
- idle admission fails closed for every missing signal;
- a Base Sepolia payment completes end to end before public mainnet activation;
- one real Taskmarket submission is locally verified, explicitly approved, submitted once, and
  tracked through acceptance or rejection;
- an executor-zone compromise drill proves there is no route or reusable credential back to Jarvis,
  the seller, GitHub, client roots, or the wallet signer;
- dashboard labels distinguish proposed, submitted, accepted, settled, and recognized revenue.
