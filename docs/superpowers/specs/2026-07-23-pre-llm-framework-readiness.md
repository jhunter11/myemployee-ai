# Pre-LLM Framework Readiness Contract

**Date:** 2026-07-23  
**Status:** Verified

## Outcome

Jarvis has a complete, testable deterministic control-plane slice and one narrow model-turn
boundary that can be exercised with fakes before any real LLM is connected. Model execution stays
off by default. The gateway, chat, conversations, client registry, demo automation, memory graph,
and operator read models remain useful without provider credentials or model traffic.

This milestone means **ready to begin a separately approved, read-only LLM connection**. It does not
mean that every item in the production-reliability or governed-self-editing roadmaps is complete.

## Included

- Strict, loopback-only gateway startup and readiness.
- Durable client and exact-agent conversation state.
- Deterministic Jarvis responses and honest `runtime_not_configured` responses.
- Default-off, versioned, operator-owned model enablement.
- A trusted text-only model-turn coordinator whose surface and client scope are bound by server
  composition rather than request text.
- Strict request/context limits before provider I/O and a second enablement/version/allow-list
  check immediately before execution.
- Provider candidates derived only from the durable operator allow-list.
- Bounded, validated provider results and metering metadata with no prompt or response persistence.
- Durable provider rate-limit circuits, crash-safe half-open recovery, exact retry scheduling, and
  a distinct cooling-down result.
- CLI subprocess isolation: a structured message envelope through stdin, trusted Claude policy
  through a single-use owner-only system-prompt file, a minimal environment, and no Claude tools,
  customizations, MCP, or session persistence. Gemini CLI generation has no execution opt-in.
- One deterministic framework verification command covering format, lint, types, coverage, both
  builds, memory graph validation, and whitespace integrity.

## Explicitly deferred

- Enabling a real provider or sending a live model prompt.
- Model access to tools, memory sleeves, arbitrary client context, or action proposals.
- Model-driven worker execution or autonomous agency work.
- Telegram/calendar/Gmail provider activation.
- Treating ordinary worker completion as proof. The production roadmap still must replace direct
  `succeeded` writes with pending verification, deterministic settlement, and finalization before a
  model may cause work.
- The remaining production-reliability, release-attestation, ToolSmith, governed-self-editing,
  testnet, remote-access, and 14-day acceptance tasks.

## Safety invariants

1. Request text cannot select a client, surface, provider, tool, memory sleeve, or authority.
2. Disabled, malformed, stale, or changed enablement fails closed before provider execution.
3. The pre-LLM coordinator accepts no tool schemas or tool calls.
4. A skipped cooldown produces no usage event and reports a bounded retry time.
5. A crash after a half-open claim cannot disable a provider forever or admit two recovery trials.
6. Provider output identity, model, cost basis, counters, and declared tool names are validated
   before success is metered.
7. No prompt, completion, provider response body, credential, or tenant payload is written to
   global telemetry.
8. Gemini credential presence alone never makes its CLI executable.

## Acceptance

```bash
npm run verify:framework
```

Additionally, a live temporary-state smoke must prove:

- `/livez` and `/readyz` return `200`;
- clients and exact-agent conversations survive restart;
- Jarvis replies deterministically;
- non-Jarvis work returns `runtime_not_configured`;
- the `acme_corp` fixture runs end to end;
- model enablement remains disabled and `model_usage_events` remains empty.

The whole repository must not be described as production-complete while the active reliability
roadmap reports unfinished work. Any later LLM milestone must cite this contract and state exactly
which deferred boundary it is crossing.
