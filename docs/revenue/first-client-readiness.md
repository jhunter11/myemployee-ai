# First-Client Readiness Handoff

> **Commercial supersession (2026-07-21):** This document proves technical readiness for the Daily
> Lead Triage fixture; it no longer authorizes treating that offer as the first-client wedge. Demand
> research paused the offer. Use [demand-led-pivot.md](./demand-led-pivot.md) for the current
> commercial decision and evidence plan.

> **Scope clarification (2026-07-20):** This readiness decision applies only to the deterministic
> Daily Lead Triage Pilot. The Company Intelligence Assistant is a proposed flagship and is not yet
> production-ready. Use [agency-launch-roadmap.md](./agency-launch-roadmap.md) for the current
> dual-track plan and its product, security, and commercial gates.

**Decision date:** 2026-07-20

**Agency lane:** historical technical proof; commercial offer paused

**Local unattended control plane:** `GO` with a disk-capacity warning

**Autonomous outreach, remote access, and external payment:** `NO-GO`

For the Daily Lead Triage Pilot, Jarvis is at the point where the next commercial work is finding
and qualifying a real first client. The system can preserve a bounded client compartment, cycle an exact registered worker,
publish tenant-private artifacts, fail closed, recover, and show review-safe status in the local
dashboard. It has not signed a client, sent outreach, collected money, or deployed a billable x402
endpoint. The separate x402/MCP seller is now locally executable and deployment-ready, but it has
not received a real testnet or mainnet payment.

## Exit acceptance matrix

| Capability                     | Status                     | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concrete first offer           | Ready                      | The Daily Lead Triage Pilot has an exact scope, $750 founding month, $1,250 continuation, qualification gates, objections, and signed acceptance criteria. Prices are proposals, not revenue.                                                                                                                                                                                                                                                               |
| Outreach strategy              | Ready for operator review  | Ten Charlotte roofing businesses are `identified`; none is falsely marked qualified. Three channel-specific drafts exist. Every recipient, channel, message, and send remains a separate human decision.                                                                                                                                                                                                                                                    |
| Truthful demo                  | Ready                      | The synthetic `acme_corp/daily-report` fixture has 10 rows and 5 deterministic qualified rows. The runbook keeps prospect and client data out of the sales demo.                                                                                                                                                                                                                                                                                            |
| Client compartment             | Proven with synthetic data | The live lifecycle scaffolded `acme_corp`, executed the exact tenant-bound worker, wrote the private report and Mermaid trace under mutable state with owner-only permissions, and exposed only bounded summaries globally.                                                                                                                                                                                                                                 |
| Failure and recovery           | Proven                     | An initial live cycle failed closed when an immutable-release path was selected. The error, failed run, task history, and P1 audit evidence were preserved. After the state-path fix, a distinct task succeeded and the P1 was resolved without deleting failure evidence.                                                                                                                                                                                  |
| Unattended cycling             | `GO` locally               | Two macOS LaunchAgents supervise the loopback gateway and watchdog. Runtime audit passes the immutable release, secure state, exact loaded release, `caffeinate`, loopback listener, and readiness checks.                                                                                                                                                                                                                                                  |
| Operator dashboard             | Ready locally              | Desktop and 390 px mobile checks have no horizontal overflow or console errors. Queue, Runs, Clients, Growth, Knowledge, System, and Saved views activate the correct single visible panel.                                                                                                                                                                                                                                                                 |
| x402 / custom MCP revenue path | Testnet deployment ready   | The separate seller serves one deterministic HTTP/MCP product, negotiates a real x402 v2 Base Sepolia 402 response with the official facilitator, records successful settlements in a dedicated append-only ledger, and has an isolated VPS profile. No public host, receive address, completed testnet payment, mainnet activation, or recognized revenue exists. No earlier reusable x402 implementation was found in the authenticated GitHub inventory. |

## The remaining first-client loop

1. Run `./scripts/runtime/runtime-audit.sh`; continue only when the result is `GO`.
2. Open `http://127.0.0.1:3000/dashboard?view=growth` on this Mac and choose one `identified`
   business from the Agency lane.
3. Re-open its official site, confirm the current business facts and a permitted business-contact
   channel, and complete the compliance gate in
   [outreach-drafts.md](./outreach-drafts.md). Do not treat a homeowner quote form as permission.
4. Have one human qualify the workflow using
   [offer-and-qualification.md](./offer-and-qualification.md). A public fit score is not discovery.
5. If the pain and authority are real, show the ten-minute synthetic proof in
   [demo-runbook.md](./demo-runbook.md). Do not request prospect data for the demo.
6. Approve the exact recipient, channel, subject, body, sender identity, and evidence for one
   message. Send it manually. Editing the message invalidates that approval.
7. Before accepting real data, sign the scope, boundary, retention, deletion, success tests, and
   stop procedure in [objections-and-acceptance.md](./objections-and-acceptance.md).
8. Scaffold the real tenant only after the signed boundary. Build against synthetic acceptance rows,
   then accept one minimized sample through the agreed secure transfer path.

The first conversation is a discovery test, not a closing script. If the buyer already has a good
saved filter, cannot provide a bounded export, wants autonomous homeowner contact, or cannot name a
workflow owner and budget, disqualify the opportunity instead of expanding the pilot.

## Operator-absence boundary

- Leave the Mac on AC power and the user session available. `caffeinate -s` prevents system sleep
  only while on AC power and does not guarantee lid-closed operation.
- The dashboard and gateway remain loopback-only. Remote access is intentionally disabled; being
  away does not authorize a tunnel, port forward, Screen Sharing, or a public mutation endpoint.
- Docker may leave `/health` degraded while `/readyz` remains ready; Docker is optional to this
  control plane. Treat a core readiness failure differently from an optional dependency warning.
- Free disk is in the warning band. The startup guard refuses new work below the critical threshold,
  and the watchdog rotates bounded logs, but storage-heavy jobs should wait until capacity is
  reclaimed deliberately.
- Jarvis may cycle already-authorized exact workers. It may not qualify prospects, send outreach,
  accept client data, sign terms, expose x402/MCP publicly, or initiate payment while the operator is
  absent. A separate hourly Codex automation may run the bounded read-only Taskmarket scout, but the
  current host denies that scan while free disk remains below 20%.

## x402 / MCP promotion gate

The task-market seller is an implemented, containerized service in this repository, separate from
the Jarvis gateway. Before public testnet promotion:

1. Supply a dedicated public Base Sepolia receive address and a public TLS origin.
2. Provision a separate seller VPS/account using
   [task-market deployment guidance](../../deploy/task-market/README.md), with no route or reusable
   credential back to Jarvis.
3. Verify the pinned image, firewall, TLS proxy, request limits, compromise drill, and kill switch
   while `TASK_MARKET_ACCEPTING_WORK=false`.
4. Complete one end-to-end Base Sepolia payment and reconcile the successful settlement receipt.
5. Require a separate exact operator decision before enabling public work, and another typed
   approval before any mainnet configuration or revenue claim.

Until the dashboard read model is deliberately migrated and backed by the new settlement evidence,
its task-market card must continue to say simulation, external payment blocked, and recognized
revenue none. Deployment-ready code is not collected revenue.

## Recheck commands

```bash
./scripts/runtime/runtime-audit.sh
curl -fsS http://127.0.0.1:3000/readyz | jq .
curl -fsS http://127.0.0.1:3000/api/v1/dashboard/overview | jq .
curl -fsS http://127.0.0.1:3000/api/v1/dashboard/revenue | jq .
```

Use [README.md](./README.md) as the acquisition-pack index and
[../operations/unattended-runtime.md](../operations/unattended-runtime.md) for activation,
rollback, and remote-access boundaries.
