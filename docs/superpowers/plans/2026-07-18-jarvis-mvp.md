# Jarvis MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every behavior and superpowers:verification-before-completion before each milestone commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a locally runnable, tested Jarvis control plane and an end-to-end `acme_corp` automation.

**Architecture:** Compose focused Express, Kysely, client-lifecycle, supervisor, worker, and monitoring modules through explicit dependencies. Production and tests use the same behavior; tests replace only the project root, database path, clock, and OS/network probes.

**Tech Stack:** Node.js 22+, TypeScript, Express 5.2, Kysely 0.28, better-sqlite3 12, Zod 4, Vitest 4, Supertest, tsx, ESLint 8, Prettier 3.

## Global Constraints

- Execute `memory/core/schema.sql` and `memory/clients/_template/schema.sql` unchanged.
- Client IDs match `^[a-z][a-z0-9_]{2,62}$`; request values never form import paths or shell commands.
- Every production behavior starts with a focused failing test that is observed failing for the intended reason.
- V8 coverage thresholds are 85 for lines, functions, branches, and statements on core modules.
- All runtime files are under `src/`; tests mirror them under `tests/`; client-specific code is under `clients/<id>/`.
- Each phase writes `memory/build_logs/phase_<n>.md` and uses the exact requested milestone commit message.

## File map

- `src/config/{paths,schemas,policies}.ts`: paths and validated contracts/policies.
- `src/db/{types,database,migrations,repositories}.ts`: SQLite lifecycle and persistence.
- `src/clients/{scaffold,service}.ts`: filesystem plus registry transaction.
- `src/agents/{worker-registry,supervisor,escalation,toolsmith}.ts`: execution hierarchy.
- `src/gateway/{app,routes,middleware,metrics,server}.ts`: HTTP and composition.
- `src/monitoring/{heartbeat,scheduler}.ts`: checks and timed lifecycle.
- `src/memory/{markdown-graph,graph-cli}.ts`: GUI-free note creation and wiki-link adjacency validation.
- `src/utils/{errors,mermaid-logger}.ts`: safe failures and traces.
- `clients/acme_corp/automations/daily-report.ts`: demo worker.
- `tests/**`: behavior-first tests with temporary roots and real SQLite.

### Task 1: Foundation and schemas

**Interfaces:**

```ts
export function createDatabase(options: {
  projectRoot: string;
  filename: string;
}): Promise<DatabaseContext>;
export const ClientConfigSchema: z.ZodType<ClientConfig>;
export class ClientRepository {
  list(): Promise<ClientRecord[]>;
  create(input: NewClient): Promise<ClientRecord>;
}
```

- [ ] Create package/config files and install only researched dependencies.
- [ ] Write `tests/config/schemas.test.ts` asserting valid defaults, unsafe IDs, unknown keys, invalid run states, escalation severities, and tool policies.
- [ ] Run `npm test -- tests/config/schemas.test.ts`; confirm missing-module failure.
- [ ] Implement the minimal Zod contracts; rerun and confirm pass.
- [ ] Write `tests/db/database.test.ts` that opens temporary SQLite and asserts all canonical tables plus `agent_runs` and foreign keys.
- [ ] Run the focused DB test; confirm missing database factory failure.
- [ ] Implement exact SQL loading, additive migration, types, and repositories; rerun schema/DB tests.
- [ ] Run format, lint, typecheck, focused coverage; write `phase_1.md`; commit `feat: project foundation — TS, SQLite, schemas, tests`.

### Task 2: Gateway and client registry

**Interfaces:**

```ts
export function createApp(deps: AppDependencies): Express;
export class Metrics {
  recordRequest(): void;
  recordError(): void;
  recordRun(clientId: string, at: string): void;
}
```

- [ ] Write Supertest cases for `/health`, empty/listed clients, valid creation, invalid JSON/body, duplicates, 404s, tenant mismatch, logging, and metrics.
- [ ] Run the focused route test and record the missing app-factory failure.
- [ ] Implement JSON parsing, middleware ordering, routes, typed application errors, and repository-backed registry.
- [ ] Rerun all gateway and existing tests; refactor only while green.
- [ ] Write `phase_2.md` and commit `feat: API gateway with client registry and health endpoint`.

### Task 3: Client lifecycle and policy enforcement

**Interfaces:**

```ts
export async function scaffoldClient(
  input: ScaffoldInput,
  deps: ScaffoldDependencies
): Promise<ScaffoldResult>;
export class PolicyService {
  resolveToolPolicy(profile: ClientProfile): ToolPolicy;
  resolveNetworkPolicy(clientId: string): NetworkPolicy;
}
export class MarkdownGraph {
  createClientNode(input: ClientNodeInput): Promise<void>;
  recordRun(input: RunNodeInput): Promise<void>;
  rebuild(): Promise<GraphIndex>;
}
```

- [ ] Write temporary-root tests for safe directories, copied templates, initialized per-client SQLite, agent stub, default network denial, profile grants, duplicates, traversal rejection, and rollback.
- [ ] Write graph tests for YAML metadata, global/client indexes, wiki-link adjacency, tenant-private note placement, and broken-link rejection; run them and observe the missing graph module failure.
- [ ] Run the focused test and observe missing scaffold/policy behavior.
- [ ] Implement validated policy snapshots, filesystem scaffolding with atomic config writes, Markdown note writes, and graph rebuild/validation.
- [ ] Integrate scaffolding with client creation and rerun route/lifecycle tests.
- [ ] Write `phase_3.md` and commit `feat: client lifecycle — scaffold, policies, DB persistence`.

### Task 4: Supervisor and Mermaid logger

**Interfaces:**

```ts
export interface FlowLogger {
  start(taskId: string): void;
  log(from: string, to: string, message: string): void;
  save(): Promise<string>;
}
export interface Worker {
  id: string;
  run(context: WorkerContext): Promise<JsonValue>;
}
export class Supervisor {
  run(input: SupervisorRunInput): Promise<SupervisorRunResult>;
}
```

- [ ] Write logger tests for sanitization, ordered `sequenceDiagram` output, isolated runs, and save path.
- [ ] Run logger tests and observe missing implementation.
- [ ] Implement the logger, then rerun to green.
- [ ] Write supervisor tests for closed routing, running→succeeded state, provenance/frequency updates, failed state, P1 audit row, saved failure trace, and linked success/failure run notes.
- [ ] Run supervisor tests and observe missing routing/lifecycle behavior.
- [ ] Implement registry, escalation, and supervisor; add the run route and Gateway handoffs.
- [ ] Rerun all tests; write `phase_4.md`; commit `feat: hierarchical supervisor execution engine with mermaid data flow logger`.

### Task 5: `acme_corp` end-to-end automation

**Interfaces:**

```ts
export async function runDailyReport(context: DailyReportContext): Promise<DailyReport>;
// DailyReport: { generatedAt, sourceRows: 10, qualifiedCount, qualifiedLeads }
```

- [ ] Add the ten-row sample fixture and a direct test asserting exact counts/records and file equality.
- [ ] Run the direct test and observe the missing automation failure.
- [ ] Implement the minimal CSV parser/filter/atomic report write and rerun to green.
- [ ] Register only `acme_corp/daily-report`; add an API test covering scaffold → run → DB/output/diagram evidence.
- [ ] Run the API test and observe the unregistered/incomplete path failure, then wire the worker and rerun all Phase 5 tests.
- [ ] Write `phase_5.md` and commit `feat: acme_corp demo client with daily-report automation`.

### Task 6: Monitoring and ToolSmith

**Interfaces:**

```ts
export class Heartbeat {
  check(): Promise<HeartbeatResult>;
}
export class ToolSmith {
  evaluate(threshold?: number): Promise<ToolSmithProposal[]>;
}
export function startMonitoring(deps: MonitoringDependencies): {
  trigger(): Promise<void>;
  stop(): void;
};
```

- [ ] Write heartbeat tests for healthy/degraded result shape, empty failures, 10% disk boundary, and optional service failures.
- [ ] Run and observe missing heartbeat implementation; implement pure aggregation plus bounded production adapters.
- [ ] Write ToolSmith tests for below/at threshold and exact dummy `{ skill: "5-d-build" }` payload; run red, implement, rerun green.
- [ ] Write scheduler tests for immediate trigger, overlap suppression, unref/stop lifecycle; run red, implement, rerun green.
- [ ] Wire health metrics and server lifecycle; rerun all tests.
- [ ] Write `phase_6.md` and commit `feat: monitoring, heartbeat, and toolsmith auto-generation`.

### Task 7: Verification, review, and handoff

- [ ] Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run coverage`, and `npm run build`; diagnose failures systematically and add regression tests before fixes.
- [ ] Run `npm run memory:graph`, inspect the tree and adjacency index, and confirm there are no broken links or tenant-data leaks.
- [ ] Start `npm run dev`, wait for the listening line, then curl health, list clients, create/confirm `acme_corp`, and run `daily-report`.
- [ ] Compare HTTP result, `report.json`, run row, audit state, and Mermaid trace.
- [ ] Update README, KANBAN, DECISIONS, and `phase_7.md` with exact evidence and known limitations.
- [ ] Dispatch an independent whole-branch review from the pre-plan base SHA through HEAD; fix Critical/Important findings test-first and re-review.
- [ ] Repeat the full fresh verification commands after all review fixes.
- [ ] Commit `chore: MVP complete — docs, tests, verification` and write the 5D retrospective.
