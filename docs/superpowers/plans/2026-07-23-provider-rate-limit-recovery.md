# Provider Rate-Limit Recovery Plan

**Status:** Completed and verified in the pre-LLM checkpoint

**Goal:** When every subscription route is unavailable or rate-limited, continue through the operator-authorized local provider without repeatedly hammering a throttled service. Reconsider each throttled provider at its trustworthy reset time plus five minutes, with an hourly reconciliation safety net.

## Invariants

- Provider order and the request's deny-first `allowedProviders` list remain authoritative.
- A skipped cooldown does not create a usage event because no provider call occurred.
- Only documented, structured reset metadata is trusted. Unknown resets cool down for one hour.
- Cooldown state is global per provider and durable in SQLite because subscription limits apply to the host account, not a tenant.
- At the retry boundary, exactly one request may claim the provider for a half-open trial. Other concurrent requests continue to the next authorized provider.
- Success closes the circuit. Another rate limit reopens it. A different half-open failure releases the claim so recovery cannot become stuck.
- Credential-presence probes never clear a cooldown; they do not prove quota availability.
- No prompt, completion, credential, or raw provider response is persisted.

## Work

1. Extend `ProviderError` with `rate_limited` and optional validated `resetAt`.
2. Normalize Claude, Codex, and Gemini quota failures. Parse only `Retry-After` or equivalent structured metadata exposed by the adapter.
3. Add migration `021_provider_rate_limit_circuits.sql` and a repository with atomic `claim`, `open`, `close`, `release`, and due-provider reads.
4. Make `ModelExecutor` consult the repository before an attempt and update it after each trial.
5. Add a recovery scheduler that wakes for the earliest `notBefore` boundary and performs an hourly due-state reconciliation. Actual quota verification remains the first half-open model request unless a provider gains a documented non-generative quota endpoint.
6. Wire the durable repository through the model-stack factory without weakening operator enablement.

## Verification

- Adapter tests for rate-limit classification and reset parsing.
- Repository tests for one-hour fallback, reset-plus-five, restart persistence, and single-claim concurrency.
- Executor tests for immediate local fallback, skipped repeated calls, half-open success, and repeated throttling.
- Scheduler tests for reset-boundary wakeup, hourly reconciliation, stop/drain, and error containment.
- Focused model/database tests, then formatting, lint, typecheck, build, and the full release test suite.

Final evidence is recorded in `memory/build_logs/brain_pre_llm_readiness.md`.
