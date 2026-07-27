# Agent Workbench Gap Analysis

## Code Gaps

| Gap                                        | Spec Item        | Complexity | Notes                                                          |
| ------------------------------------------ | ---------------- | ---------- | -------------------------------------------------------------- |
| Profile/continuation schemas               | 24 catalog       | moderate   | No durable profile model exists.                               |
| Seeded hierarchy and tool/sleeve manifests | 24 catalog       | moderate   | Current hierarchy is hardcoded HTML.                           |
| Conversation/message migration             | 24 conversations | moderate   | Browser memory is the only transcript store.                   |
| Exact-agent conversation repository        | 24 conversations | complex    | Requires append-only messages and optimistic versioning.       |
| Profile response service                   | 24 routing       | moderate   | Current service knows only Jarvis intents.                     |
| Bounded agent APIs                         | 24 endpoints     | complex    | Must derive scope from catalog and fail closed.                |
| Gateway composition                        | 24 endpoints     | moderate   | Repositories and services are not wired.                       |
| Workbench renderer                         | 24 UI            | complex    | Existing chat lacks explorer, inspector, and per-agent state.  |
| Dynamic Agent Floor                        | 24 UI            | moderate   | Static topology/rows must use the catalog projection.          |
| URL state and mobile drawers               | 24 UI            | moderate   | Agent/conversation selection is not reloadable.                |
| Accessibility and responsive states        | 24 UI            | moderate   | Tree keyboard model and 390px flow are missing.                |
| MCP/x402 pre-testnet fixes                 | 24 x402          | complex    | Record now; activation remains outside this batch.             |
| Behavioral/security/browser tests          | all              | complex    | Exact routing, persistence, isolation, and live UI need proof. |

## Knowledge Gaps

- **Model executor:** no provider adapter exists; use deterministic/profile-only modes and keep the port explicit.
- **MCP/x402:** current official transport/tool/payment guidance was checked; annotations, Origin validation, output schema, and payment precision need future corrections.
- **Remote identity:** no authenticated operator principal exists; retain loopback-only mutation.

## System Gaps

- Add an idempotent SQLite migration for conversations/messages.
- Profile manifests remain static and versioned in code; no dynamic loading or chat-created profiles.
- The current knowledge scope repository models structural harness/project/client indexes, so V1 agent sleeves are catalog grants and cannot query a filesystem until scoped retrieval is implemented.
- No wallet/signing capability may enter the Jarvis process.

## Alignment Gaps

- The UI must distinguish durable profiles, ephemeral runs, and unavailable runtimes.
- “Below Jarvis” means coordination/navigation, not inherited authority.
- MCP/x402 remains a separate task-market trust domain, not Agency revenue.

## Unknowns

- None blocking this slice. Provider selection, remote access, testnet, mainnet, and autonomous external actions are explicitly deferred.

**Total gaps:** 16
**High-complexity gaps:** 5
**Blockers:** profile contracts precede persistence/API; persistence/API precede the functional UI.
