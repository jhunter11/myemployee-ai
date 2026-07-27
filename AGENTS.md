# Jarvis Repository Instructions

## Required workflow router

Use `$jarvis-workflows` from `skills/jarvis-workflows/SKILL.md` whenever a task touches any of these trigger lanes:

- Page/dashboard: create or change an operator page, view, widget, dictation, navigation, or Page Studio workflow.
- Memory: change Markdown graph memory, Obsidian compatibility, backlinks, graph indexing, or recovery.
- Automation: add or change a client worker, artifact lifecycle, execution policy, escalation, or recovery.
- Economics: change or analyze model routing, token usage, context compression, caching, budgets, or work per dollar.

Read only the matching skill reference unless the request genuinely spans lanes. This single router is intentional: it keeps always-on skill metadata smaller than four overlapping skills.

## Engineering defaults

- Plan non-trivial work and use test-driven development.
- Check current documentation before using unfamiliar APIs.
- Preserve tenant boundaries and deny-first policy.
- Prefer deterministic behavior before model calls.
- Run focused tests while iterating and the complete release gate before claiming completion.
