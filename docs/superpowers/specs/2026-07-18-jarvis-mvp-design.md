# Jarvis MVP Design

## Intent

Convert the existing AI-agency blueprint into a deterministic local control plane that can onboard a tenant, expose status, execute a registered client workflow, persist evidence, and pass the attached acceptance checks. The build intentionally proves boundaries rather than simulating an LLM or cloud deployment.

## Chosen approach

A dependency-injected TypeScript modular monolith is the smallest approach that keeps the blueprint's future service boundaries visible. Express owns HTTP only; Kysely repositories own persistence; client services own safe filesystem lifecycle; a supervisor owns routing and run state; workers own deterministic client behavior; monitoring owns infrastructure facts. Tests compose the same modules against temporary project roots and SQLite.

Two other approaches were rejected:

- Dynamic client-module imports reduce registration work but turn request values into executable paths.
- A LangGraph or queue-based distributed runtime better resembles the eventual platform but adds nondeterminism and operations before the basic contract is proven.

## Data and isolation

The existing global and client SQL files are executed unchanged. Their `client_registry` and `audit_logs` names implement the phase brief's conceptual client/audit stores; `agent_runs` is additive. Every client receives a separate SQLite file, memory template, validated config, data/output directories, and agent stub. Client IDs are lowercase snake case and validated before path construction.

## Request and execution flow

`createApp()` returns an unbound Express application. Client creation validates input, resolves policy, scaffolds a temporary-safe directory, persists registry state, and rolls back partial work. Run requests reject tenant-header mismatches, resolve a closed worker registration, create one run and Mermaid logger, execute the worker, then update that same run. Failures become P1 audit records and safe API errors.

The demo registry contains only `acme_corp/daily-report`. Its worker reads a checked-in ten-row CSV, selects qualified leads, and returns `{ generatedAt, sourceRows, qualifiedCount, qualifiedLeads }`. Report publication uses a per-artifact lease plus a durable, hash-checked filesystem journal. Gateway startup reconciles interrupted journals against the database run status before listening: succeeded runs retain their recognized report, while other states restore the recognized prior report or absence. It atomically queues every interrupted `running` row for evidence recovery, then idempotently overwrites stale run memory and Mermaid evidence, links one P1 recovery audit, and clears the durable marker last.

## Markdown graph/tree memory

Jarvis memory is usable as plain files without an IDE and remains compatible with Obsidian conventions. Notes have YAML frontmatter and `[[wiki-links]]`; the folder hierarchy supplies a readable tree, while `npm run memory:graph` builds a machine-readable adjacency file and rejects broken links. The global graph contains agency/client/run metadata only. Every client receives a private note index under its own memory boundary, and supervisor success/failure writes a linked run note without copying client data into the global graph.

## Operations

`/health` reports gateway/database liveness, optional Ollama/Docker facts, disk state, and process-local request metrics. Optional dependency failures yield `degraded` JSON but do not prevent the gateway responding. A non-overlapping unref'd interval runs heartbeat and ToolSmith every fifteen minutes. ToolSmith only produces a dummy `5-d-build` PR payload when a task signature reaches five executions.

## Error and security boundaries

- No request-derived imports or shell commands.
- OS probes use direct `execFile` arguments and bounded network requests.
- Unknown JSON fields and unknown automations are rejected.
- Full automation requires a strict, matching owner-approval JSON record stored as a regular non-symlink file inside the project root; the demo has no network access.
- Existing tenant trees reject symlinks/special files, managed policy grants update atomically, and onboarding plus graph mutations are serialized in process.
- Checked-in client data assets are copied into custom tenant roots with bounded reads and exclusive no-clobber publication; tenant-created files win races and survive rollback.
- Transaction hooks are all-or-none. Publication is serialized from prepare through release/rollback, rollback uses content fingerprints, and unresolved journals fail closed until startup recovery.
- Mermaid task IDs/messages are sanitized and each run has an isolated logger.
- V1 enforces one live gateway per file-backed database with a kernel-backed exclusive transaction on a dedicated mode-`0600` SQLite lock database, and assumes an application-owned local client tree. The primary database's existing parent is canonicalized; final symlinks and multiply linked/non-file paths are rejected. Process death releases the lock automatically, while malformed lock databases fail closed. Every process sharing a client root must share that database path; `:memory:`, distributed, or independently writing processes require stronger coordination.
- No real Telegram, Docker containment, PR, merge, secret, or external LLM action occurs in V1.

## Verification design

Tests follow red-green-refactor and favor real modules. Mocks exist only at OS/network boundaries. Coverage includes schemas, exact SQL initialization, repositories, app routes, scaffold/policies, supervisor success/failure, Mermaid output, Markdown graph construction/link validation, daily report direct/API paths, heartbeat, scheduler, metrics, and ToolSmith. V8 thresholds are 85% for branches, functions, lines, and statements. Final acceptance uses a built runtime plus fresh curl calls, graph validation, and output-file inspection.

The authoritative interface details are in the repository root [SPEC.md](../../../SPEC.md).
