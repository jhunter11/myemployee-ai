---
name: jarvis-workflows
description: Route and execute verified workflows in the ai-agency-jarvis repository. Use for dashboard pages, views, or dictation; Obsidian Markdown memory, Graphify, or scoped knowledge; priority queue, lane, claim, or ordering work; client onboarding or automations; token, model, compression, latency, or cost optimization; prospects, offers, outreach, first-client readiness, x402, A2A, or task-market work; and unattended runtime, launchd, caffeinate, deployment, or remote-access security. Trigger for phrases such as create a page, traverse the codebase, what should Jarvis do next, work per dollar, or get the first client.
---

# Jarvis Workflows

Route Jarvis work through one compact skill, then load only the reference for the selected lane.

## Route the request

1. Confirm the repository root and inspect `git status --short`.
2. Select the smallest matching lane and read its complete reference:
   - Page or dashboard work: [references/page.md](references/page.md)
   - Markdown graph or memory work: [references/memory.md](references/memory.md)
   - Priority queue or multi-agent coordination: [references/queue.md](references/queue.md)
   - Client automation work: [references/automation.md](references/automation.md)
   - Token, model, compression, or cost work: [references/economics.md](references/economics.md)
   - Revenue, outreach, x402, or A2A work: [references/revenue.md](references/revenue.md)
   - Unattended runtime, deployment, caffeinate, or remote-access work:
     [references/operations.md](references/operations.md)
3. Read multiple references only when the request genuinely spans multiple lanes.

## Execute

1. Inspect the relevant specification, implementation, and tests with bounded `rg` queries.
2. Verify current library or platform documentation before using an unfamiliar API.
3. Write a failing behavioral or regression test first.
4. Make the smallest safe implementation that satisfies the request and preserves tenant boundaries.
5. Run the focused test without global coverage, then run typecheck and lint.
6. Run the full release gate before completion: tests with coverage, format check, build, graph rebuild, and `git diff --check`.
7. For UI changes, exercise the live browser at desktop and mobile widths and inspect console errors.

Client principals receive capabilities already bound to their exact registered client scope. Never
let request text select a tenant, graph partition, repository path, queue tenant, or credential.

## Spend context deliberately

- Prefer fixed schemas, deterministic planners, local indexes, and repository queries before model calls.
- Read source slices and interfaces before whole files. Exclude `node_modules`, `dist`, `coverage`, and vendored `skills/superpowers` unless directly relevant.
- Delegate only independent, bounded work. Give each agent file ownership and request concise evidence.
- Keep tool output bounded. Summarize durable decisions in specs or Markdown memory instead of repeatedly reloading conversation history.
- Never invent token prices or usage. Label estimates, retain source/model identifiers, and fail closed when usage metadata is unavailable.
