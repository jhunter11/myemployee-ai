# Jarvis V1 Operator and Client-Demo Handoff

## Release truth

Jarvis V1 is a private, loopback-only operator control plane. Its strongest working path is:

- a responsive web dashboard at `http://127.0.0.1:3000/dashboard`;
- deterministic Jarvis chat over bounded local read models, with evidence references and no model
  call;
- restart-persistent conversations bound to the exact selected agent profile;
- a server-owned 34-profile Jarvis → Agency / MCP/x402 hierarchy with declared tools, memory
  sleeves, knowledge scope, continuation stages, budgets, and escalation targets;
- Today, Calendar, Personal Memory, Agency, Work Queue, Runs, Clients, Growth, Knowledge, Runtime,
  and Page Studio views;
- isolated Markdown personal memory, a separate global agency graph, and tenant-private client roots;
- a deterministic synthetic `acme_corp/daily-report` worker with queue, run, audit, artifact, trace,
  and startup-recovery evidence; and
- an opt-in private Telegram adapter with Keychain token lookup, exact user/chat allowlists,
  long-poll replay protection, redacted inbox evidence, bounded reads, and a `/pause` proposal.

The working UI is an operator demo, not proof that every displayed profile is an autonomous agent.
Only `jarvis` has a wired deterministic conversation adapter. Agency, its specialists/templates, and
MCP/x402 have useful profile conversations, but work requests return `runtime_not_configured` until
an exact executor is separately wired and verified.

## Capability status

| Capability                        | Current status                                                                                                                                                | Do not claim                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Web dashboard and Jarvis chat     | Working locally on loopback                                                                                                                                   | Authenticated internet access or a live LLM                                                     |
| Agent hierarchy and conversations | Working and persistent; non-Jarvis profiles are `profile_only`                                                                                                | That the displayed Agency, developer, red/blue, or idea agents execute work                     |
| Personal memory                   | Read-only dashboard over isolated Markdown records, including an owner-only unattended state root                                                             | Conversational remembering, autonomous writes, or Agency/client access                          |
| Calendar                          | Local-demo events, conflict detection, planning, and approval classification work                                                                             | A connected Google or Outlook account, live sync, or provider writes                            |
| Telegram                          | Adapter and gateway lifecycle are implemented; disabled until explicitly configured                                                                           | That a bot credential, chat, webhook, or live connection already exists                         |
| Agency automation                 | One deterministic synthetic client worker plus one durable, audited active/paused execution posture shared by dashboard, queue claims, and run commit fencing | A production customer, unrestricted autonomy, outbound contact, or a general worker marketplace |
| Page Studio                       | Data-only preview, fingerprint, confirmation, and allowlisted publication work                                                                                | Generated executable UI, arbitrary endpoints, or automatic publication                          |
| MCP/x402                          | Contract and task-market simulation evidence only; paid CLI activation is hard-blocked pending Task 29                                                        | A wallet, signing, testnet/mainnet payment, external submission, or recognized revenue          |
| Backup and recovery               | Run/artifact crash recovery, launchd restart, disk guard, and manual cold-state backup are available                                                          | A completed disaster-restore drill or managed backup service                                    |

Migrations `009`–`017` add governed blueprint records, scopes/sleeves/grants, scoped lexical
retrieval, Telegram inbox state, action proposals, provider-neutral calendar connection state,
delegation traces, access-lifecycle audit evidence, and the agency execution posture. These are deny-first foundations. Their
presence does not by itself make a profile executable. Gateway startup now installs the declared
profile/scope/sleeve catalog, but the catalog still reports `authorizationReady: false` because only
the blueprint layer exists; no effective run constraint has been granted. Delegation has a bounded
read-only SSE composition and action proposals have an exact decision path. Retrieval consumers,
blueprint execution, a calendar-provider adapter, delegation producers/frontend streaming, and
access-lifecycle controls still require explicit composition before they are operator features.

## Local launch

Requirements: Node.js 22+, npm, and a free loopback port. From the repository root:

```bash
npm ci
npm run build
npm start
```

In another terminal:

```bash
curl --fail --silent http://127.0.0.1:3000/livez
curl --fail --silent http://127.0.0.1:3000/readyz
open http://127.0.0.1:3000/dashboard
```

`HOST` must remain `127.0.0.1`, `::1`, or `localhost`. Do not put this gateway behind a reverse
proxy or tunnel. The local mutation boundary is not an internet authentication system.

## Seven-minute client demo

1. Open **Today**. State immediately that the two calendar rows are local demo data. Show the
   briefing, approval count, source availability, and the distinction between empty and unavailable.
2. Open **Jarvis** and ask: `What needs my attention today?` Then ask: `Show agency agent status.`
   Open the evidence references and explain that this response is deterministic and token-free.
3. Open **Agents**. Traverse Jarvis → Agency → Developer → Code Blue / Code Red, then the separate
   MCP/x402 branch. Open a profile conversation and ask about its purpose, tools, memory, and
   continuation plan. If asked to execute work, show the honest `runtime_not_configured` response.
4. Open **Agency**, **Work Queue**, and **Runs**. Show reversible internal work separately from
   approval-required or blocked work, then show the synthetic daily-report run evidence. Do not call
   `acme_corp` a customer.
5. Open **Calendar** and **Personal Memory**. Show conflict/focus planning with no provider write,
   then explain that personal Markdown is outside the agency/client graph.
6. Open **Page Studio**. Preview a quick recipe, inspect its mappings, checks, gaps, and fingerprint,
   then confirm a data-only page. Explain that unknown capabilities route back to repository work.
7. Close with one bounded-pilot question: “Which repeated internal decision currently requires two
   exports, is reversible, and has an objective acceptance check?” Sell that workflow—not a generic
   autonomous agent.

Do not make Telegram part of the live demo unless the operator has deliberately completed the
activation and live-private-chat checks below.

## Private Telegram activation

Telegram is disabled by default. Activation supports one exact positive user ID and one exact
positive private-chat ID. Group/channel IDs, bot senders, unsupported commands, and free-text
authority requests fail closed. Supported commands are `/today`, `/status`, `/queue`, `/projects`,
`/pause`, and `/help`; `/pause` creates a five-minute proposal and changes no runtime state until
the loopback desktop operator approves that exact current version and fingerprint. Exact approval
atomically records the decision and engages the durable pause; rejection does not change posture.

First create the bot outside this repository and obtain the two exact private-chat identifiers.
Keep the bot token out of shell arguments, environment variables, plist files, logs, and Git. Store
it interactively in the macOS login Keychain; `-w` must remain the final option so the command
prompts instead of placing the token in shell history:

```bash
JARVIS_TELEGRAM_KEYCHAIN_SERVICE='com.aiagency.jarvis.telegram'
JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT='bot-token'

/usr/bin/security add-generic-password -U \
  -s "$JARVIS_TELEGRAM_KEYCHAIN_SERVICE" \
  -a "$JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT" \
  -w
```

Run the complete release gate and require a clean worktree before assigning the Git revision as the
immutable release ID. Then inspect a side-effect-free install plan using placeholders replaced only
in the operator's shell:

```bash
git status --short
JARVIS_RELEASE_ID="$(git rev-parse HEAD)"
JARVIS_NODE_BIN="$(command -v node)"
JARVIS_TELEGRAM_USER_ID='<positive-user-id>'
JARVIS_TELEGRAM_CHAT_ID='<positive-private-chat-id>'

./scripts/runtime/install-launch-agent.sh \
  --dry-run \
  --release-id "$JARVIS_RELEASE_ID" \
  --node-bin "$JARVIS_NODE_BIN" \
  --telegram-user-id "$JARVIS_TELEGRAM_USER_ID" \
  --telegram-chat-id "$JARVIS_TELEGRAM_CHAT_ID" \
  --telegram-keychain-service "$JARVIS_TELEGRAM_KEYCHAIN_SERVICE" \
  --telegram-keychain-account "$JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT"
```

The JSON result must say `telegramConfigured: true`, `loaded: false`, and `host: "127.0.0.1"`.
Review the planned paths, then repeat the same command with `--install`. The installer writes only
the allowlisted identifiers and Keychain handles to the unloaded LaunchAgent; it never writes the
bot token and never calls `launchctl`.

Explicitly activate and audit the installed runtime:

```bash
JARVIS_GUI_DOMAIN="gui/$(id -u)"

launchctl bootstrap "$JARVIS_GUI_DOMAIN" \
  "$HOME/Library/LaunchAgents/com.aiagency.jarvis.gateway.plist" \
  "$HOME/Library/LaunchAgents/com.aiagency.jarvis.watchdog.plist"

./scripts/runtime/runtime-audit.sh
```

Require `status: "GO"`, then send `/help` and `/today` from the exact allowlisted private chat.
Restart the gateway and confirm that a replayed update is not answered twice. Treat any startup,
Keychain, polling, allowlist, or audit failure as **not configured**; do not loosen the allowlist or
move the token into an environment variable to make it work.

## Calendar provider handoff

The provider-neutral persistence and sync seam exists, but no Google or Outlook adapter, OAuth
callback, credential, or live connection is configured. Keep the default UI labeled `local_demo`
until the operator names the calendar they actually use.

The next implementer should:

1. select exactly one provider from the operator's answer, without adding the other “just in case”;
2. implement `CalendarProviderAdapter.pullIncremental({ cursor, limit })` with a fixed
   `providerKey` and strict response conversion into the existing bounded delta contract;
3. use provider-native authorization with PKCE/state and the narrowest read-only calendar scope;
4. store refresh/access material in macOS Keychain and persist only bounded connection state plus a
   validated Keychain handle if one is needed—never tokens or raw provider errors;
5. register and activate the exact `personal:jarvis` connection, start with a null cursor, persist
   each delta transactionally, and continue only while `hasMore` is true;
6. map expired credentials, revocation, provider unavailability, invalid responses, and invalidated
   cursors to the existing explicit connection states; reset to a scoped full sync only after a
   reviewed provider-specific recovery rule;
7. compose `ProviderCalendarReader` into the briefing/dashboard only after sync tests pass, while
   retaining distinct unavailable/stale/empty UI states; and
8. keep all provider writes, invitations, attendee changes, cancellations, and external messages
   disabled. Add private write proposals only through a later exact approval policy.

Acceptance requires an actual read-only account connection, incremental and full-resync evidence,
restart recovery, revocation/expiry tests, no token or private event body in general logs, and a
dashboard source change from `local_demo` to a truthful provider state. Until then, show the local
calendar and say “provider not connected.”

## Trust boundaries

- Browser access is loopback-only; URL, query text, or tree location grants no authority.
- Command principals, scopes, trust domains, policies, and tenant bindings are server-owned. Message
  text cannot select a tenant, sleeve, tool, wallet, or approval authority.
- Hierarchy is navigation and containment only. Profile declarations and grants do not make an
  executor live, and no authority is inherited through parent/child edges.
- Personal, Agency, MCP/x402, and client data remain separate. Cross-scope sharing must be a reviewed,
  materialized bundle; it is not a live pointer into another index.
- Telegram is `read` + `propose`, not `approve` or `execute`; its inbox keeps hashes and redacted
  classifications rather than raw message text.
- Page Studio publishes allowlisted data manifests, never runtime HTML or JavaScript.
- External contact, contracts, pricing commitments, releases, destructive operations, policy
  changes, payments, and client disclosure remain operator-gated.
- MCP/x402 remains simulation-only with no wallet, signing, withdrawal, or mainnet authority. The
  paid seller environment rejects activation until the separate Task 29 MCP annotations, output
  schema, and Origin review passes.
- The UI exposes observable evidence and structured traces, never hidden reasoning or raw private
  transcripts.

## Backup and recovery

The unattended runtime separates immutable releases from mutable owner-only state under
`~/Library/Application Support/Jarvis/state`. Gateway startup reconciles interrupted synthetic
report journals and marks interrupted runs failed with durable audit/trace evidence. launchd
restarts non-zero exits, the watchdog checks liveness/readiness, and the disk guard holds new work
before storage is exhausted.

Take a cold backup only after stopping the watchdog and gateway so SQLite, WAL, artifacts, clients,
workspaces, graph memory, and personal memory are one consistent state set:

```bash
JARVIS_GUI_DOMAIN="gui/$(id -u)"
JARVIS_STATE_ROOT="$HOME/Library/Application Support/Jarvis/state"
JARVIS_BACKUP_ROOT="$HOME/Library/Application Support/Jarvis/backups/$(date -u +%Y%m%dT%H%M%SZ)"

launchctl bootout "$JARVIS_GUI_DOMAIN/com.aiagency.jarvis.watchdog"
launchctl bootout "$JARVIS_GUI_DOMAIN/com.aiagency.jarvis.gateway"

/usr/bin/install -d -m 0700 "$JARVIS_BACKUP_ROOT"
/usr/bin/ditto "$JARVIS_STATE_ROOT" "$JARVIS_BACKUP_ROOT/state"
(
  cd "$JARVIS_BACKUP_ROOT"
  /usr/bin/find state -type f -exec /usr/bin/shasum -a 256 {} +
) > "$JARVIS_BACKUP_ROOT/SHA256SUMS"
/bin/chmod 0600 "$JARVIS_BACKUP_ROOT/SHA256SUMS"
```

Bootstrap the same inspected LaunchAgents again and require `runtime-audit.sh` to return `GO`.
Never copy only `jarvis.sqlite` while the process is live, and never omit `clients`, `workspaces`, or
memory roots from a preservation copy.

V1 does **not** yet contain an automated, destructive restore command or completed disaster-restore
drill. Treat the backup as preservation evidence, restore only into a separate stopped install root,
verify the hash manifest and private modes, and audit that isolated runtime before any cutover. If an
artifact journal or database binding is ambiguous, preserve it and stop; do not delete evidence or
force a success state.

## Exact verification

Focused V1 foundations:

```bash
npx vitest run \
  tests/dashboard/routes.test.ts \
  tests/dashboard/agent-workbench-app.test.ts \
  tests/dashboard/agent-workbench-server.test.ts \
  tests/agents/profile-catalog.test.ts \
  tests/agents/conversation-repository.test.ts \
  tests/agents/access-control-repository.test.ts \
  tests/agents/access-lifecycle-service.test.ts \
  tests/blueprints/blueprint-lifecycle.test.ts \
  tests/knowledge/lexical-retrieval.test.ts \
  tests/knowledge/context-compiler.test.ts \
  tests/delegation/delegation-service.test.ts \
  tests/delegation/delegation-sse.test.ts \
  tests/channels/telegram-channel.test.ts \
  tests/channels/telegram-runtime.test.ts \
  tests/gateway/server-telegram.test.ts \
  tests/personal/calendar-provider-sync.test.ts \
  tests/operations/unattended-runtime.test.ts \
  --coverage.enabled=false
```

Complete release gate:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run taskmarket:build
npm run memory:graph
git diff --check
```

Live proof requires `/livez` and `/readyz`, a clean browser console, no document overflow at 375,
768, 1024, and 1440 CSS pixels, usable keyboard focus, readable 200% text zoom, and truthful
loading/empty/unavailable states. Credentialed Telegram and calendar checks are separate activation
evidence; unit tests do not prove that an external account is connected.
