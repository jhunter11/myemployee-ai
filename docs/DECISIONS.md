# Architecture Decision Records — Jarvis Multi-Provider Brain

This log records the durable, operator-relevant decisions made while giving the
Jarvis control plane a multi-provider model brain. Each entry states the context,
the decision, and why it preserves the system's fail-closed safety boundaries.
Entries are append-only; supersede rather than rewrite.

## ADR-001 — Model execution is gated by a durable, operator-owned enablement record (default OFF)

**Context.** `routeModelWork()` historically hardcoded `modelExecutionAllowed:false`
so the MVP never executed a model (SPEC §15). Crossing that gate must never delete
the guard — it must put the guard behind an explicit, auditable switch.

**Decision.** Added a durable singleton `model_execution_enablement` record
(migration `020`) mirroring the `agency_execution_posture` pattern: version-checked
optimistic CAS, an append-only `model_execution_enablement_events` audit table, and
`INSERT OR IGNORE` bootstrap that defaults to **disabled** with empty allow-lists.
The record stores `enabled`, `version`, `approver`, `approved_at`, and the allowed
logical `tiers`, `surfaces`, and `providers`. Turning it on is the only thing that
can permit a real model call.

**Router wiring.** `routeModelWork(rawInput, enablement?)` takes an optional,
provider-agnostic snapshot (`{ enabled, allowedTiers, version }`). When the snapshot
is absent, disabled, malformed, or does not cover the resolved tier, the decision is
byte-identical to the historical deterministic/simulation behaviour — proven by a
parity test over a full input matrix. Network policy still wins over an enabled tier
(deny-first). The router remains provider-agnostic; provider/surface gating lives in
the separate binding layer (Phase B+).

**Fail-closed.** The router `safeParse`s the snapshot (malformed → treated as
disabled), the repository `parse`s every row (corrupt row → throws), and
`resolveSnapshot()` catches any read failure and returns the disabled snapshot. A
corrupt or unreadable record can never accidentally permit execution.

## ADR-002 — The secrets plane reads on-disk OAuth stores and reports status without ever exposing token bytes

**Context.** Existing subscription logins live on disk: `~/.codex/auth.json`
(ChatGPT/Codex OAuth), `~/.gemini/oauth_creds.json` (Google OAuth), the Claude Code
subscription credential in the macOS Keychain (generic-password service
`Claude Code-credentials`; no `~/.claude/.credentials.json` and no headless
`CLAUDE_CODE_OAUTH_TOKEN` on this host by default), and the OpenClaw Telegram
allowlist under `~/.openclaw/credentials/`.

**Decision.** `src/secrets/provider-credentials.ts` inspects these sources and
answers one question per provider — is a usable credential present? — returning only
a bounded, non-secret `{ provider, state, source, detail }`. Token bytes are never
returned, logged, or embedded in `detail`; read/parse errors are sanitized to
`missing`/`malformed`. Keychain presence is probed with `security
find-generic-password` **without** `-w`/`-g`, so only the exit code is observed. The
Gemini reader treats a refreshable (refresh-token-present) credential as `valid` even
when the access token has expired. `jarvis auth status` (`npm run auth:status`)
prints one line per provider and a summary.

## ADR-003 — Metering under subscriptions: `subscription` cost is NULL, `local` cost is genuinely 0 (implemented, Phase B)

**Context.** SPEC §15 requires that unknown cost stays SQL `NULL` and is never
converted to zero. The briefing mandates recording subscription calls with a NULL
cost basis `subscription` and Ollama calls with a `0` basis `local`. The existing
`model_usage_events.cost_basis` only allows `unknown|observed|estimated`.

**Decision.** Extend the cost basis with:

- `subscription` → `cost_microusd IS NULL`, counted as **unknown-cost coverage**
  (never as $0), because the per-call dollar cost of a flat subscription is genuinely
  unknown.
- `local` → `cost_microusd = 0`, basis `local`, because a local Ollama call incurs no
  metered API charge (electricity is out of scope, consistent with SPEC §15's intent).

This honours both the briefing's explicit basis labels and SPEC §15's rule against
inventing zeros for genuinely unknown cost.

**Implementation.** Migration `003` now allows the widened basis on fresh databases;
an idempotent, code-level `applyProgrammaticMigrations` (run on every `openDatabase`)
rebuilds an existing legacy `model_usage_events` table in place to widen the CHECK
constraint — following SQLite's canonical table-rebuild procedure (foreign-key
enforcement is toggled off around the DROP/RENAME and restored afterwards; the table
is a leaf, and rows are copied verbatim). `ModelUsageRepository` accepts the two new
bases, persists NULL/0 cost respectively, and the dashboard summary reports
`subscriptionCostEvents`/`localCostEvents` — subscription rolls into unknown-dollar
coverage, local into known coverage as a genuine 0.

## ADR-004 — OpenClaw reuse and attribution (Codex OAuth implemented, Phase B; Telegram Phase E)

**Context.** `~/openclaw` (MIT, v2026.6.2) already implements ChatGPT/Codex OAuth
token read/refresh and Telegram config formats we need.

**Decision.** Adapt OpenClaw's OAuth-token read/refresh and Telegram-config handling
rather than inventing new formats, so existing logins and the existing Telegram
pairing carry over. Reused patterns and files are recorded in
[`THIRD_PARTY.md`](../THIRD_PARTY.md) with MIT attribution as they are introduced.

**Implementation (Phase B).** The Codex provider adapts OpenClaw's verified OAuth
facts — the `auth.openai.com/oauth/token` refresh grant with client id
`app_EMoamEEZ73f0CkXaXp7hrann`, and the `chatgpt_account_id` JWT-claim extraction —
re-implemented against this project's interfaces (no OpenClaw files copied). The
ChatGPT-backend `responses` request/parse path could not be live-verified on this
host, so it is deliberately fail-closed (any non-2xx / malformed body throws and the
executor degrades). Telegram-config reuse remains Phase E.

## ADR-005 — Provider-binding layer sits behind the router; the router stays provider-agnostic

**Context.** SPEC §15 keeps `routeModelWork()` as pure policy (risk → logical tier →
whether to call at all) that never learns a provider name. The briefing requires a
separate multi-provider executor bound to those logical tiers, routed through
subscriptions (not metered API keys), degrading gracefully.

**Decision.** Added `src/models/*`: a `ModelProvider` interface with one thin,
dependency-injected adapter per provider — **Claude** (`claude -p` headless CLI, run
locked-down: JSON output, no MCP, every built-in tool denied), **Codex/ChatGPT**
(OAuth over `~/.codex/auth.json`), **Gemini** (`gemini -p` headless CLI), and
**Ollama** (`localhost:11434` HTTP) — plus a `ProviderCatalog` that probes
availability and binds each logical route to a concrete provider by the fixed
preference order (Claude → Codex → Gemini for economy/frontier; Ollama for local and
as the universal backstop), and a `ModelExecutor` that enforces the operator
enablement provider allow-list (deny-first), attempts the catalog's ordered
candidates with call-time fall-through, and writes one `model_usage_events` row per
attempt with the serving provider's label and cost basis (subscription = NULL,
local = 0). When no authorized provider is available it returns `no_runtime` and
never fabricates a reply.

**Availability vs. live validity.** The catalog probes credential _presence_ (via the
secrets plane) and runtime _liveness_ (Ollama `GET /api/tags`); it cannot cheaply
prove a subscription token is still valid server-side. A call-time auth failure
(observed on this host: the Claude token is revoked and the Gemini free tier is
ineligible) surfaces as a typed `ProviderError` and the executor degrades to the next
candidate — presence-based binding plus call-time fall-through, fail-closed
throughout. `npm run models:status` reports the live picture without executing a model.

**Unit vs. integration.** A `FakeModelProvider` drives the catalog/executor unit
tests; the real adapters are thin seams behind injected CLI/`fetch` runners, with a
live Ollama integration test that runs a real completion when the runtime is serving
and skips otherwise.

## ADR-006 — Rate-limit recovery uses durable circuits and truthful half-open calls

**Context.** Call-time fall-through alone retries a throttled subscription on every
new request. Credential-presence probes cannot establish that quota has recovered,
and restart must not erase a known cooldown.

**Decision.** Claude, Codex, and Gemini normalize structured quota failures to
`ProviderError.kind = rate_limited`. Before falling through, `ModelExecutor` opens a
global SQLite circuit for that provider. A trustworthy future reset becomes
`notBefore = resetAt + 5 minutes`; missing, stale, or malformed reset metadata uses a
one-hour cooldown. Calls before `notBefore` skip the subscription without writing a
usage event because no call occurred. At the boundary, an atomic update admits one
half-open real request while concurrent work continues through the authorized
fallback. Success deletes the circuit; another quota failure reschedules it.

The gateway schedules the earliest boundary and an hourly reconciliation, logging
only provider and timestamp metadata. It never clears a circuit from a
credential-presence probe and never persists provider response bodies. Lazy claim
checks remain authoritative if a timer is delayed or the process restarts.

## ADR-007 — Finish a text-only pre-LLM boundary before connecting provider traffic

**Context.** The provider adapters, router, enablement record, usage ledger, deterministic chat,
and exact-agent conversations existed as separate tested pieces. Calling `ModelExecutor` directly
could still let a future caller supply provider authority, omit durable cooldown state, or send an
unvalidated runtime request. The active reliability and governed-self-editing roadmaps also contain
substantial unfinished work, so “framework complete” needs a narrower honest milestone.

**Decision.** The pre-LLM milestone is the contract in
`docs/superpowers/specs/2026-07-23-pre-llm-framework-readiness.md`. Production model construction
must expose a `ModelTurnCoordinator`, not a bare executor. The coordinator binds its surface and
client scope at composition, accepts text-only requests, enforces aggregate context/output/time
caps, derives providers from the durable operator allow-list, and repeats the enablement/version
check immediately before execution.

**Status update.** The gateway now constructs this coordinator and wires
`src/chat/jarvis-model-chat.ts` on top of it, so a real model turn is reachable. This does not widen
the milestone: the deterministic keyword router remains the switch-off fallback, and model execution
stays OFF in the durable operator-owned enablement record until an operator enables it. Credential
presence is still not execution authority.

CLI execution is also deny-first. Claude receives trusted policy through its real system channel
using a single-use `0600` prompt file in a `0700` directory; a JSON message envelope travels through
stdin. Built-in tools, customizations, MCP, and session persistence are disabled, the subprocess
environment is allowlisted, and cleanup failure fails closed. Because the documented Gemini CLI
does not provide an equivalent complete built-in-tool denial and no-persistence boundary, Gemini
has no production execution opt-in even when its OAuth credential is present. Credential presence
is not execution authority.

Model tools, memory retrieval, worker dispatch, and side effects remain outside this milestone.
They cannot be enabled until effective access-lifecycle composition exists; model-caused worker
execution additionally waits for proof-gated pending/verification/settlement semantics.
